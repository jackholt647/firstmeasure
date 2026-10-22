import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright-core';

/* 1M8-221 (show/hide password), 1M8-223 (add another account) and 1M8-227 (no New Report without order_reports). */
const portal = new URL('../../portal/', import.meta.url);
const libraries = new URL('../../libraries/', import.meta.url);
const read = (base, file) => readFile(new URL(file, base), 'utf8');

async function withPage(run) {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
  try { await run(await browser.newPage()); } finally { await browser.close(); }
}

test('password fields get a show/hide button on pages and inside a shadow root', async () => {
  const toggle = await read(portal, 'landing/shared/password-toggle.js');
  await withPage(async (page) => {
    await page.setContent('<form id="f"><label>Password <input type="password" name="password" value="hunter22"></label></form><div id="host"></div>');
    await page.addScriptTag({ content: toggle });
    await page.evaluate(() => {
      const shadow = document.getElementById('host').attachShadow({ mode: 'open' });
      shadow.innerHTML = '<form><input type="password" name="new_password"></form>';
      FirstMatePasswordToggle.enhance(document);
      FirstMatePasswordToggle.enhance(shadow);
      FirstMatePasswordToggle.enhance(document); // a second call adds nothing
    });
    assert.equal(await page.locator('#f .fm-pw-toggle').count(), 1);
    const button = page.locator('#f .fm-pw-toggle');
    assert.equal(await button.getAttribute('aria-label'), 'Show password');
    await button.click();
    assert.equal(await page.locator('#f input[name="password"]').getAttribute('type'), 'text');
    assert.equal(await button.getAttribute('aria-label'), 'Hide password');
    assert.equal(await button.getAttribute('aria-pressed'), 'true');
    await button.click();
    assert.equal(await page.locator('#f input[name="password"]').getAttribute('type'), 'password');
    // Inside the widget's shadow root, with its own styles.
    assert.equal(await page.evaluate(() => document.getElementById('host').shadowRoot.querySelectorAll('.fm-pw-toggle, style[data-fm-password-toggle]').length), 2);
    // The button sits inside the input's box.
    const [input, icon] = await Promise.all([page.locator('#f input').boundingBox(), button.boundingBox()]);
    assert.ok(icon.x + icon.width <= input.x + input.width && icon.x > input.x && icon.y >= input.y - 1);
  });
});

test('the password pages and the signup widget load the toggle', async () => {
  assert.match(await read(portal, 'login.php'), /password-toggle\.js[^\n]*\n<script>window\.FirstMatePasswordToggle\?\.enhance\(document\);<\/script>/);
  assert.match(await read(portal, 'activate.php'), /password-toggle\.js[\s\S]{0,200}FirstMatePasswordToggle\?\.enhance\(document\)/);
  const widget = await read(portal, 'landing/shared/signup-widget.js');
  assert.match(widget, /new URL\('password-toggle\.js', SCRIPT_SRC\)/);
  assert.match(widget, /loadPasswordToggleLibrary\(\)\.then\(\(toggle\) => toggle\.enhance\(shadow\)\)/);
});

test('adding another account sends the login form\'s identifier and shows the server\'s reason', async () => {
  const switcher = await read(libraries, 'account-switcher/account-switcher.js');
  assert.ok(/identifier: String\(formData\.get\('identifier'\) \|\| formData\.get\('email'\) \|\| ''\)\.trim\(\)/.test(switcher), 'identifier sent');
  assert.ok(/return \{ success: false, error: error\.code \|\| '', message: error\.message/.test(switcher), 'error code passed to the widget');
  const api = await read(new URL('../', import.meta.url), 'platform/api.ts');
  const route = api.slice(api.indexOf('app.post("/auth/accounts/add"'), api.indexOf('app.post("/auth/accounts/switch"'));
  assert.ok(route.includes('identifier: body.identifier || body.email'), 'route reads identifier');
});

test('without order_reports the New button and the mobile + do not offer a report', async () => {
  const index = await read(portal, 'index.php');
  const start = index.indexOf('    (function initNewMenu(){');
  const menu = index.slice(start, index.indexOf('    })();', start) + 9);
  assert.ok(start > 0 && menu.length > 1000, 'new menu found');
  await withPage(async (page) => {
    await page.setContent('<aside class="sidebar"><div id="newMenuWrap"><button id="btnNewReq"><span>New</span><i></i></button><div id="newMenuPopout"></div></div></aside><button id="mobNewReqBtn"><i></i><span>New</span></button>');
    await page.evaluate(() => {
      window.__events = [];
      window.addEventListener('fm:new-project-workflow', (event) => window.__events.push(event.detail.workflow));
      window.sidebar = document.querySelector('.sidebar');
      window.closeSidebar = () => {};
      window.Portal = { currentUser: { permissions: { view_reports: true } }, util: { hasPerm: (key) => !!window.Portal.currentUser.permissions['*'] || !!window.Portal.currentUser.permissions[key] } };
    });
    await page.addScriptTag({ content: menu.replace('(function initNewMenu(){', 'window.__initNewMenu = (function initNewMenu(){') });
    assert.equal(await page.locator('#newMenuWrap').evaluate((e) => e.hidden), true, 'viewer: no New button');
    assert.equal(await page.locator('#mobNewReqBtn').evaluate((e) => e.hidden), true, 'viewer: no mobile +');
    await page.evaluate(() => { window.Portal.currentUser.permissions = { view_reports: true, order_reports: true }; window.dispatchEvent(new CustomEvent('fm:perms:updated')); });
    assert.equal(await page.locator('#newMenuWrap').evaluate((e) => e.hidden), false, 'orderer: New button');
    assert.equal(await page.locator('#mobNewReqBtn').evaluate((e) => e.hidden), false, 'orderer: mobile +');
    await page.locator('#btnNewReq').click();
    assert.deepEqual(await page.evaluate(() => window.__events), ['report']);
  });
  const request = await read(libraries, 'apps/project-request/app.js');
  assert.ok(/if \(workflow === 'report' && Object\.keys\(window\.Portal\?\.currentUser\?\.permissions \|\| \{\}\)\.length && !hasPerm\('order_reports'\)\) \{/.test(request), 'the order window refuses with a reason');
});
