import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import test from 'node:test';
import { chromium } from 'playwright-core';

// The sandbox Apps tab in a browser, against a mocked API: tiles and their states, the state popover and its save
// (expected_revision, the platform CSRF header), a conflict, keyboard use and a 390px layout.

const app = (id, title, state, extra = {}) => ({
  id, title, icon: 'fa-images', surface: id.startsWith('project.') ? 'project_modal' : 'portal_tab', order: 10, state, reason: state === 'off' ? 'flag_disabled' : '',
  switches: [{ key: `switch.${id}`, label: `${title} switch`, on: state === 'on' }], offerable: false, offer_siblings: [], shared_with: [], placement: '', pill: '',
  features: [], options: [], ...extra
});
function model(revision, states = {}) {
  const pick = (id, fallback) => states[id] || fallback;
  return {
    ok: true,
    configuration: { id: 'swf_fixture', title: 'Fixture', source: 'library', revision, editable: true, copy_state: 'library' },
    csrf_cookie: 'fm_platform_session_csrf',
    groups: [
      { id: 'portal_tab', title: 'Portal apps', apps: [app('portal.viewer', 'My Projects', pick('portal.viewer', 'on'), { options: [{ key: 'map_first', label: 'Open on the map', description: 'Map first.', default: false, value: false }] }), app('portal.scheduling', 'Scheduling', pick('portal.scheduling', 'off'))] },
      { id: 'project_modal', title: 'Project tabs', apps: [app('project.photos', 'Project Photos', pick('project.photos', 'on'), { offerable: true, pill: 'new', features: [{ key: 'photos.markup', label: 'Markup', description: 'Draw on photos.', type: 'boolean', options: [], value: true, effective: true, configured: true, available: true, locked: false, depth: 1 }] })] },
      { id: 'contact_modal', title: 'Contact tabs', apps: [] }
    ],
    offers: []
  };
}

test('Apps tab: states, the popover save, a conflict, keyboard and 390px', async () => {
  let executablePath;
  for (const file of ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', '/usr/bin/chromium', chromium.executablePath()]) {
    try { await access(file); executablePath = file; break; } catch {}
  }
  assert.ok(executablePath, 'A Chromium browser is required.');
  const browser = await chromium.launch({ headless: true, executablePath });
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await context.addCookies([{ name: 'fm_platform_session_csrf', value: 'csrf-token-1', domain: 'apps.test', path: '/' }]);
    const page = await context.newPage();
    const root = new URL('../../portal/signup-sandbox/', import.meta.url);
    const puts = [];
    let revision = 3;
    let states = {};
    let conflictNext = false;
    let reads = 0;
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/*', async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.pathname.endsWith('/state')) return route.fulfill({ json: { ok: true, workflows: [{ id: 'swf_fixture', title: 'Fixture', entry_mode: 'signup_first', stages: [{ id: 'stg_a', page_id: 'spg_a', notes: '' }], defaults: {} }], pages: [{ id: 'spg_a', title: 'Signup page', role: 'signup', status: 'builtin' }], test_orgs: [] } });
      if (url.pathname.endsWith('/workflows/swf_fixture/apps') && request.method() === 'GET') { reads += 1; return route.fulfill({ json: model(revision, states) }); }
      const write = url.pathname.match(/\/workflows\/swf_fixture\/apps\/([^/]+)$/);
      if (write && request.method() === 'PUT') {
        const body = request.postDataJSON();
        puts.push({ app: decodeURIComponent(write[1]), body, csrf: request.headers()['x-platform-csrf'] });
        if (conflictNext) { conflictNext = false; revision += 1; return route.fulfill({ status: 409, json: { ok: false, code: 'config_library_revision_conflict', error: 'Stale.' } }); }
        if (body.state) states = { ...states, [decodeURIComponent(write[1])]: body.state };
        revision += 1;
        return route.fulfill({ json: { ...model(revision, states), changed: true } });
      }
      const filename = url.pathname.split('/').at(-1);
      if (['index.php', 'sandbox.js', 'sandbox.css'].includes(filename)) return route.fulfill({ body: await readFile(new URL(filename, root)), contentType: filename === 'index.php' ? 'text/html' : filename.endsWith('.js') ? 'application/javascript' : 'text/css' });
      return route.fulfill({ body: '' });
    });
    await page.goto('http://apps.test/portal/signup-sandbox/index.php');

    // Apps is the default view; Launch test instance is in the header above both views.
    const appsTab = page.getByRole('tab', { name: 'Apps' });
    await appsTab.waitFor();
    assert.equal(await appsTab.getAttribute('aria-selected'), 'true');
    await page.getByRole('button', { name: 'My Projects: On' }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Launch test instance' }).isVisible(), true);
    assert.equal(await page.locator('.sbx-app-tile').count(), 3);
    assert.equal(await page.getByRole('button', { name: 'Scheduling: Off' }).count(), 1);
    assert.equal(await page.locator('.sbx-legend-item').count(), 3);
    assert.equal(await page.locator('.sbx-app-tile[data-app="project.photos"] .sbx-app-pill').textContent(), 'New');

    // The popover: three states, Offered unavailable for an app without a welcome, saved with the revision and CSRF.
    await page.getByRole('button', { name: 'Scheduling: Off' }).click();
    const dialog = page.getByRole('dialog', { name: 'Scheduling' });
    await dialog.waitFor();
    assert.equal(await dialog.getByRole('button', { name: 'Offered', exact: true }).isDisabled(), true);
    assert.equal(await dialog.getByRole('button', { name: 'Off', exact: true }).getAttribute('aria-pressed'), 'true');
    await dialog.getByRole('button', { name: 'On', exact: true }).click();
    await page.getByRole('button', { name: 'Scheduling: On' }).waitFor();
    assert.deepEqual(puts.at(-1), { app: 'portal.scheduling', body: { expected_revision: 3, state: 'on' }, csrf: 'csrf-token-1' });
    assert.match(await page.locator('#sbx-apps-status').textContent(), /Saved · revision 4/);
    assert.equal(await page.getByRole('dialog', { name: 'Scheduling' }).isVisible(), true, 'the popover stays open after a save');

    // Escape closes it and gives focus back to the tile.
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('.sbx-app-pop').count(), 0);
    assert.equal(await page.evaluate(() => document.activeElement?.dataset.app), 'portal.scheduling');

    // Keyboard: Enter opens, Advanced holds the app's features; a feature saves on its own.
    await page.locator('.sbx-app-tile[data-app="project.photos"]').focus();
    await page.keyboard.press('Enter');
    const photos = page.getByRole('dialog', { name: 'Project Photos' });
    await photos.waitFor();
    await photos.locator('summary').click();
    await photos.getByRole('checkbox', { name: /Markup/ }).uncheck();
    await page.waitForFunction(() => /revision 5/.test(document.getElementById('sbx-apps-status')?.textContent || ''));
    assert.deepEqual(puts.at(-1).body, { expected_revision: 4, features: { 'photos.markup': false } });
    assert.equal(await page.locator('.sbx-app-pop details').evaluate((node) => node.open), true, 'Advanced stays open after a save');
    await photos.getByLabel('Tab pill').selectOption('');
    await page.waitForFunction(() => /revision 6/.test(document.getElementById('sbx-apps-status')?.textContent || ''));
    assert.deepEqual(puts.at(-1).body, { expected_revision: 5, pill: '' });

    // A conflict reloads the configuration and says so; nothing is retried behind the person's back.
    conflictNext = true;
    const readsBefore = reads;
    await page.getByRole('dialog', { name: 'Project Photos' }).getByRole('button', { name: 'Offered', exact: true }).click();
    await page.waitForFunction(() => document.getElementById('sbx-apps-status')?.classList.contains('is-conflict'));
    assert.ok(reads > readsBefore);
    assert.equal(puts.length, 4);

    // Sign-up flow is the second view, by arrow key too.
    await appsTab.focus();
    await page.keyboard.press('ArrowRight');
    assert.equal(await page.getByRole('tab', { name: 'Sign-up flow' }).getAttribute('aria-selected'), 'true');
    await page.locator('.sbx-stage-tile').first().waitFor();
    assert.equal(await page.getByRole('button', { name: 'Launch test instance' }).isVisible(), true);
    await page.getByRole('tab', { name: 'Apps' }).click();

    // 390px: nothing scrolls sideways, Launch is still in view, the popover fits the screen.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('button', { name: 'My Projects: On' }).click();
    await page.getByRole('dialog', { name: 'My Projects' }).waitFor();
    const layout = await page.evaluate(() => {
      const pop = document.querySelector('.sbx-app-pop').getBoundingClientRect();
      return { overflow: document.documentElement.scrollWidth - window.innerWidth, popLeft: pop.left, popRight: pop.right };
    });
    assert.ok(layout.overflow <= 0, `no sideways scroll (${layout.overflow}px)`);
    assert.ok(layout.popLeft >= 0 && layout.popRight <= 390);
    await page.keyboard.press('Escape');
    await page.mouse.wheel(0, 600);
    assert.equal(await page.getByRole('button', { name: 'Launch test instance' }).isVisible(), true);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
