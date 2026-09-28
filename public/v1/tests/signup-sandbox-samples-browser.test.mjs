import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import test from 'node:test';
import { chromium } from 'playwright-core';

test('sample data modal sends only individually selected toggles and stays optional', async () => {
  let executablePath;
  for (const file of ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', '/usr/bin/chromium', chromium.executablePath()]) {
    try { await access(file); executablePath = file; break; } catch {}
  }
  assert.ok(executablePath, 'A Chromium browser is required.');
  const browser = await chromium.launch({ headless: true, executablePath });
  try {
    const page = await browser.newPage();
    const root = new URL('../../portal/signup-sandbox/', import.meta.url);
    const requests = [];
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.pathname.endsWith('/state')) return route.fulfill({ json: { ok: true, workflows: [], pages: [], test_orgs: [{ id: 'sbi_test', org_name: 'Sample test organization', workflow_id: 'swf_instant_full_org' }] } });
      if (url.pathname.endsWith('/sample-data')) {
        requests.push(route.request().postDataJSON());
        return route.fulfill({ json: { ok: true, samples: {} } });
      }
      const filename = url.pathname.split('/').at(-1);
      if (['index.php', 'sandbox.js', 'sandbox.css'].includes(filename)) return route.fulfill({ body: await readFile(new URL(filename, root)), contentType: filename === 'index.php' ? 'text/html' : filename.endsWith('.js') ? 'application/javascript' : 'text/css' });
      return route.fulfill({ body: '' });
    });
    await page.goto('http://samples.test/portal/signup-sandbox/index.php');
    await page.getByRole('button', { name: 'Test orgs', exact: true }).click();
    await page.getByRole('button', { name: 'Add sample data', exact: true }).click();
    assert.equal(await page.getByRole('checkbox').count(), 4);
    assert.equal(await page.locator('input:checked').count(), 0);
    await page.getByRole('button', { name: 'Add selected sample data' }).click();
    assert.equal(requests.length, 0);
    await page.getByRole('checkbox', { name: /Equipment/ }).check();
    await page.getByRole('checkbox', { name: /Customers/ }).check();
    await page.getByRole('button', { name: 'Add selected sample data' }).click();
    await page.waitForFunction(() => document.querySelector('#sbx-modal-backdrop').hidden);
    assert.deepEqual(requests, [{ equipment: true, channels: false, projects: false, customers: true }]);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
