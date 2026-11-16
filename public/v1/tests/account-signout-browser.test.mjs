import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright-core';

/* FM-477: Sign out in the account switcher, for an account this device never remembered (the app's sign-in before
   FM-476) and with the portal's confirm, which is PlatformUI's and answers with a promise. */
const switcherSource = await readFile(new URL('../../libraries/account-switcher/account-switcher.js', import.meta.url), 'utf8');

async function withBrowser(run) {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
  try { await run(browser); } finally { await browser.close(); }
}

const portalPage = (answer) => `<!doctype html><html><body><button id="accountSwitcherButton" style="position:fixed;left:8px;bottom:8px">Accounts</button><script>
  window.__APP={userOrgId:'org_a',userEmail:'a@example.test',userName:'A Person',userCompany:'A Co',platformApiBase:'/v1/platform'};
  window.asked=[];window.confirm=(message)=>{window.asked.push(message);return Promise.resolve(${answer});};
</script><script src="/account-switcher.js"></script></body></html>`;

async function openPortal(browser, { accounts, answer }) {
  const context = await browser.newContext();
  const posts = [];
  await context.route('http://fm.test/**', (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === 'POST') posts.push(url.pathname);
    if (url.pathname === '/account-switcher.js') return route.fulfill({ contentType: 'application/javascript', body: switcherSource });
    if (url.pathname === '/v1/platform/auth/accounts') return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, accounts }) });
    if (url.pathname.startsWith('/v1/platform/auth/')) return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    if (url.pathname === '/portal/login.php') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>login</title>' });
    return route.fulfill({ contentType: 'text/html', body: portalPage(answer) });
  });
  const page = await context.newPage();
  await page.goto('http://fm.test/portal/');
  await page.waitForFunction(() => !!window.FirstMateAccountSwitcher);
  await page.evaluate(() => window.FirstMateAccountSwitcher.refreshAccounts());
  await page.click('#accountSwitcherButton');
  return { page, posts };
}

test('Sign out ends the session of an account this device never remembered', async () => {
  await withBrowser(async (browser) => {
    const { page, posts } = await openPortal(browser, { accounts: [], answer: true });
    await page.click('[data-fm-account-more]');
    assert.equal(await page.getAttribute('[data-fm-account-remove]', 'data-fm-account-remove'), '');
    await page.click('[data-fm-account-remove]');
    await page.waitForURL('**/portal/login.php');
    assert.deepEqual(await page.evaluate(() => document.title), 'login');
    assert.deepEqual(posts, ['/v1/platform/auth/logout']);
  });
});

test('Sign out of a remembered account removes it and ends the session', async () => {
  await withBrowser(async (browser) => {
    const accounts = [{ account_id: 'acct_a', email: 'a@example.test', organization_id: 'org_a', name: 'A Person', organization_name: 'A Co', active: true }];
    const { page, posts } = await openPortal(browser, { accounts, answer: true });
    await page.click('[data-fm-account-more]');
    await page.click('[data-fm-account-remove]');
    await page.waitForURL('**/portal/login.php');
    assert.deepEqual(posts, ['/v1/platform/auth/accounts/remove', '/v1/platform/auth/logout']);
  });
});

test('Cancel in the portal\'s confirm keeps the session and the other account', async () => {
  await withBrowser(async (browser) => {
    const accounts = [
      { account_id: 'acct_a', email: 'a@example.test', organization_id: 'org_a', name: 'A Person', organization_name: 'A Co', active: true },
      { account_id: 'acct_b', email: 'b@example.test', organization_id: 'org_b', name: 'B Person', organization_name: 'B Co', active: false }
    ];
    const { page, posts } = await openPortal(browser, { accounts, answer: false });
    await page.click('[data-fm-account-more="acct_b"]');
    await page.click('[data-fm-account-remove="acct_b"]');
    await page.click('[data-fm-account-more="acct_a"]');
    await page.click('[data-fm-account-remove="acct_a"]');
    await page.waitForFunction(() => window.asked.length === 2);
    await page.waitForTimeout(200);
    assert.deepEqual(posts, []);
    assert.match(page.url(), /\/portal\/$/);
    assert.equal(await page.locator('[data-fm-account-select]').count(), 2);
  });
});
