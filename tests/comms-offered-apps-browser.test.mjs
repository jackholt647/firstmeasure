// GP-87: an organization offered Communications sees Communications and its Call center in the left column and More
// apps, each showing the welcome, and Get Started from either starts the one offer. Communications (chat/app.js) used
// to register its tab only once its switch (apps.comms) was on, and an offer holds that switch off, so neither app
// appeared anywhere. Runs the real app runtime, app groups (app-chrome.js), tab pills (tab-guides.js), the
// Communications registration and the welcome in Chromium, with the portal and the API stubbed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const { chromium } = createRequire(new URL('../public/v1/package.json', import.meta.url))('playwright-core');
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const read = (path) => readFileSync(new URL(`../public/libraries/${path}`, import.meta.url), 'utf8');
const RUNTIME = read('app-runtime/firstmate-embeddable-apps.js');
const CHROME_LIB = read('app-runtime/app-chrome.js');
const TAB_GUIDES = read('tab-guides/tab-guides.js');
const CHAT = read('apps/chat/app.js');
const WELCOME = read('app-runtime/app-welcome.js').replaceAll('export function', 'function');

const welcome = {
  theme: 'comms', eyebrow: { key: 'e', text: 'Communications' }, headline: { key: 'h', text: 'Every call, text and email in one place.' },
  description: { key: 'd', text: 'Calls, texts and email.' }, benefits: [{ key: 'b', text: 'Call and text' }], caption: { key: 'c', text: 'Saved on the project.' }
};

// The session as the server sends it: Communications offered (its switch masked off), Stats on.
const STUB = (offered) => `
  window.__APP = { userOrgId:'org_test' };
  const registered = [];
  window.registered = registered;
  window.Portal = {
    currentUser: { orgId:'org_test', appEntitlements: [
      { id:'portal.chat', allowed:true, visible:{ desktop:true, mobile:true }, offered:${offered}, ${offered ? `welcome:${JSON.stringify(welcome)}` : ''} },
      { id:'portal.stats', allowed:true, visible:{ desktop:true, mobile:true } }
    ] },
    capabilities: { current: () => ({ definitions_by_key:{ 'apps.comms':{}, 'apps.stats':{} }, effective_by_key:{ 'apps.comms':${!offered}, 'apps.stats':true } }) },
    appFlags: { load: async () => ({}), has: (group, key) => group === 'apps' && key === 'comms' && ${!offered} },
    apps: {
      // As core.js does: its own visibility replaces the manifest's.
      registerPortalApp(def){ registered.push(def.id); return window.FirstMateEmbeddableApps.registerApp({ ...def, kind:'portal_tab', portalTabId:def.tabId, surfaces:['portal_tab'], visible:def.visible }); },
      unregisterPortalApp(id){ registered.splice(registered.indexOf('portal.' + id), 1); }
    },
    tabs: { renderTabs(){} },
    CommunicationsWorkspace: { mount(){ return {}; } }
  };`;

async function open(browser, offered) {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  // The runtime resolves its own URL against the page's, so the page needs a real origin.
  await page.route('https://portal.test/**', (route) => route.fulfill({ contentType:'text/html', body:'<!doctype html><html><body><div id="mainPanels"></div><main id="root"></main></body></html>' }));
  await page.goto('https://portal.test/portal/');
  await page.addScriptTag({ content: STUB(offered) });
  await page.addScriptTag({ content: RUNTIME });
  // As the apps manifest registers it: listed only once its bundle registers it, gated by its switch.
  await page.evaluate(() => window.FirstMateEmbeddableApps.registerApp({ id:'portal.chat', title:'Communications', kind:'portal_tab', portalTabId:'chat', surfaces:['portal_tab'], visible:false, access:{ capability:'apps.comms' } }));
  await page.addScriptTag({ content: CHROME_LIB });
  await page.addScriptTag({ content: TAB_GUIDES });
  await page.addScriptTag({ content: CHAT });
  await page.waitForFunction(() => window.registered.includes('portal.chat'), null, { timeout: 5000 }).catch(() => null);
  return { page, errors };
}

const listed = (page) => page.evaluate(() => window.FirstMateEmbeddableApps.listApps({ surface:'portal_tab' })
  .filter((meta) => meta.enabled && meta.visible !== false).map((meta) => ({ id:meta.id, offered:meta.entitlement?.offered === true, entitlement:meta.entitlement?.id || '' })));

test('offered Communications and its Call center are listed, marked New and show the welcome (GP-87)', async () => {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  try {
    const { page, errors } = await open(browser, true);
    assert.deepEqual(await page.evaluate(() => window.registered), ['portal.chat'], 'Communications registers its tab while offered');
    const apps = await listed(page);
    const chat = apps.find((app) => app.id === 'portal.chat');
    const center = apps.find((app) => app.id === 'portal.chat.center');
    assert.ok(chat?.offered, 'Communications is listed as offered');
    assert.deepEqual(center, { id:'portal.chat.center', offered:true, entitlement:'portal.chat' }, 'the Call center is offered with Communications');
    assert.deepEqual(await page.evaluate(() => ['portal.chat', 'portal.chat.center'].map((id) => window.FirstMateTabGuides.pill(id)?.kind)), ['new', 'new']);
    assert.equal(await page.evaluate(() => window.FirstMateTabGuides.pill('portal.stats')), null, 'an app that is on is not marked New');
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('Get Started on the Call center starts the Communications offer (GP-87)', async () => {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  try {
    const { page } = await open(browser, true);
    await page.addScriptTag({ content: `${WELCOME}\nwindow.mountWelcome=mountWelcome;` });
    await page.evaluate(() => {
      window.requests = [];
      window.PlatformAPI = { request: async (path) => { window.requests.push(path); return { ok:true }; }, capabilities:{ load: async () => ({}) }, appFlags:{ load: async () => ({}) } };
      window.Portal.auth = { syncPlatformSession: async () => ({}) };
      const access = window.FirstMateEmbeddableApps.evaluateAccess('portal.chat.center', { surface:'portal_tab' });
      window.mountWelcome({ appId:'portal.chat.center', orgId:'org_test', roots:{ main:document.getElementById('root') }, entitlement:access.entitlement });
    });
    assert.equal(await page.locator('.fm-app-welcome').getAttribute('data-theme'), 'comms');
    await page.getByRole('button', { name:'Get Started' }).click();
    await page.waitForFunction(() => window.requests.some((path) => path.includes('/app-offers/')));
    assert.deepEqual(await page.evaluate(() => window.requests.filter((path) => path.includes('/app-offers/'))), ['/organizations/org_test/app-offers/portal.chat/start']);
  } finally { await browser.close(); }
});

test('with its switch on, Communications and the Call center open as before', async () => {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  try {
    const { page, errors } = await open(browser, false);
    const apps = await listed(page);
    assert.deepEqual(['portal.chat', 'portal.chat.center'].map((id) => apps.find((app) => app.id === id)?.offered), [false, false]);
    assert.deepEqual(await page.evaluate(() => ['portal.chat', 'portal.chat.center'].map((id) => window.FirstMateTabGuides.pill(id))), [null, null]);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
