import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright-core';

/* 1M8-204, 1M8-201: two tabs signed in to different accounts, the browser-wide caches, and round avatars. */
const libraries = new URL('../../libraries/', import.meta.url);
const portal = new URL('../../portal/', import.meta.url);
const read = (base, file) => readFile(new URL(file, base), 'utf8');

async function withBrowser(run) {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
  try { await run(browser); } finally { await browser.close(); }
}

const portalPage = (org, email) => `<!doctype html><html><body><button id="accountSwitcherButton"></button><script>window.__APP={userOrgId:${JSON.stringify(org)},userEmail:${JSON.stringify(email)},userCompany:${JSON.stringify(org + ' Co')},platformApiBase:'/v1/platform'};</script><script src="/account-switcher.js"></script></body></html>`;

test('a tab opened as one account stops when another tab signs this browser in to a different account', async () => {
  const switcher = await read(libraries, 'account-switcher/account-switcher.js');
  await withBrowser(async (browser) => {
    const context = await browser.newContext();
    let activeOrg = 'org_a';
    await context.route('http://fm.test/**', (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === '/account-switcher.js') return route.fulfill({ contentType: 'application/javascript', body: switcher });
      if (url.pathname === '/v1/platform/auth/accounts') return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, accounts: [] }) });
      if (url.pathname === '/v1/platform/auth/session') return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ authenticated: true, identity: { email: activeOrg === 'org_a' ? 'a@example.test' : 'b@example.test' }, membership: { organization_id: activeOrg }, organization: { id: activeOrg, name: `${activeOrg} Co` } }) });
      const [org, email] = url.pathname === '/b' ? ['org_b', 'b@example.test'] : ['org_a', 'a@example.test'];
      return route.fulfill({ contentType: 'text/html', body: portalPage(org, email) });
    });
    const tabA = await context.newPage();
    await tabA.goto('http://fm.test/a');
    await tabA.waitForFunction(() => !!window.FirstMateAccountGuard);
    assert.equal(await tabA.locator('#fmAccountChanged').count(), 0);

    // Another tab loads as account B (after a switch or a sign-in there).
    activeOrg = 'org_b';
    const tabB = await context.newPage();
    await tabB.goto('http://fm.test/b');
    await tabA.waitForSelector('#fmAccountChanged', { timeout: 5000 });
    const notice = await tabA.locator('#fmAccountChanged').innerText();
    assert.match(notice, /org_a Co \(a@example\.test\)/);
    assert.match(notice, /org_b Co \(b@example\.test\)/);
    assert.equal(await tabB.locator('#fmAccountChanged').count(), 0, 'the active account\'s own tab keeps working');

    // A request refused as belonging to another organization asks the server and shows the same notice.
    await tabA.evaluate(() => document.getElementById('fmAccountChanged').remove());
    assert.equal(await tabA.evaluate(() => window.FirstMateAccountGuard.check()), false);
    assert.equal(await tabA.locator('#fmAccountChanged').count(), 1);
    assert.equal(await tabB.evaluate(() => window.FirstMateAccountGuard.check()), true);
  });
});

test('browser-wide caches are kept per organization', async () => {
  const projectViewer = await read(portal, 'scripts/project_viewer.js');
  assert.ok(/const storeKey = \(\) => `\$\{STORE_KEY\}:\$\{String\(window\.__APP\?\.userOrgId/.test(projectViewer), 'projectViewer /const storeKey = \\(\\) => `\\$\\{STORE_KEY\\}:\\$\\{String\\(windo');
  assert.ok(!/localStorage\.(getItem|setItem)\(STORE_KEY/.test(projectViewer), 'projectViewer /localStorage\\.(getItem|setItem)\\(STORE_KEY/');
  const billing = await read(libraries, 'apps/billing/app.js');
  assert.ok(/owner === String\(window\.__APP\?\.userOrgId \|\| ''\)\.trim\(\)/.test(billing), "billing /owner === String\\(window\\.__APP\\?\\.userOrgId \\|\\| ''\\)\\.tri");
  const request = await read(libraries, 'apps/project-request/app.js');
  assert.ok(/organization_id: String\(window\.__APP\?\.userOrgId \|\| ''\)\.trim\(\),\s*fields: \{/.test(request), "request /organization_id: String\\(window\\.__APP\\?\\.userOrgId \\|\\| ''");
  const index = await read(portal, 'index.php');
  assert.ok(/if \(currentOrgId && currentOrgId !== cachedOrgId\) return false;/.test(index), 'index /if \\(currentOrgId && currentOrgId !== cachedOrgId\\) return ');
  const company = await read(libraries, 'apps/settings/company.js');
  assert.ok(/function cacheTheme\(theme\)\{\s*try\{ localStorage\.setItem\(LS_KEY, JSON\.stringify\(\{ \.\.\.\(theme \|\| \{\}\), orgId: currentOrgId\(\)/.test(company), 'company /function cacheTheme\\(theme\\)\\{\\s*try\\{ localStorage\\.setIte');
  assert.ok(/if \(String\(obj\.orgId \|\| ''\) !== currentOrgId\(\)\) return null;/.test(company), "company /if \\(String\\(obj\\.orgId \\|\\| ''\\) !== currentOrgId\\(\\)\\) re");
  const viewer = await read(libraries, 'apps/projects/viewer.js');
  assert.ok(/if \(String\(parsed\.orgId \|\| ''\) !== String\(window\.__APP\?\.userOrgId/.test(viewer), "viewer /if \\(String\\(parsed\\.orgId \\|\\| ''\\) !== String\\(window\\.__");
});

test('a pending order placed by another account in this browser is never submitted here', async () => {
  const billing = await read(libraries, 'apps/billing/app.js');
  const start = billing.indexOf('  function readPending(){');
  const readPending = billing.slice(start, billing.indexOf('\n  }', start) + 4);
  const run = (owner, current) => new Function('localStorage', 'window', 'PENDING_ORDER_KEY', `${readPending}; return readPending();`)(
    { getItem: () => JSON.stringify({ v: 3, ...(owner ? { organization_id: owner } : {}), fields: { address: '1 Main St' } }) }, { __APP: { userOrgId: current } }, 'fm_pending_order_v1');
  assert.equal(run('org_a', 'org_b'), null);
  assert.equal(run('org_a', 'org_a')?.fields.address, '1 Main St');
  assert.equal(run('', 'org_b')?.fields.address, '1 Main St', 'an order saved before this release still resumes');
});

test('a tall profile photo stays a circle', async () => {
  const kit = await read(libraries, 'apps/people/people-kit.js');
  const rules = ['.pp-avatar{', '.pp-avatar>img{'].map((selector) => { const start = kit.indexOf(selector); assert.ok(start >= 0, selector); return kit.slice(start, kit.indexOf('}', start) + 1); }).join('\n');
  await withBrowser(async (browser) => {
    const page = await browser.newPage();
    await page.setContent(`<style>${rules}</style><span class="pp-avatar" id="a" style="--pp-avatar:34px"><img></span><span class="pp-avatar" id="b" style="--pp-avatar:96px"><img></span>`);
    await page.evaluate(() => new Promise((resolve) => {
      const canvas = document.createElement('canvas'); canvas.width = 300; canvas.height = 900;
      canvas.getContext('2d').fillRect(0, 0, 300, 900);
      const images = [...document.images]; let left = images.length;
      images.forEach((image) => { image.onload = () => { if (--left === 0) resolve(); }; image.src = canvas.toDataURL(); });
    }));
    for (const [id, size] of [['a', 34], ['b', 96]]) {
      const box = await page.locator(`#${id} img`).boundingBox();
      assert.equal(Math.round(box.width), size);
      assert.equal(Math.round(box.height), size);
    }
  });
});
