// GP-8: Communications never paints unstyled while its stylesheets load. The project window draws the Comms tab's
// panelHtml (with its own "Loading…") before mount, so panelHtml injects the tab's styles and keeps the shell hidden;
// communications.css is a <link>, so whatever is drawn with it (Texts' setup panel, Calls, the Communications tab)
// stays a styled "Loading…" until CommunicationsUI.cssReady settles. Runs the real files in Chromium with the
// stylesheet request held back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const { chromium } = createRequire(new URL('../public/v1/package.json', import.meta.url))('playwright-core');
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const file = (name) => readFileSync(new URL(`../public/libraries/apps/comms/${name}`, import.meta.url), 'utf8');
const ORIGIN = 'http://fm.test';
const PAGE = `<!doctype html><html><head><script>window.FirstMateEmbeddableApps={registerApp(app){window.__commsApp=app;}};</script>
  <script src="/libraries/apps/comms/communications-ui.js"></script><script src="/libraries/apps/comms/workspace.js"></script><script src="/libraries/apps/comms/project.js"></script></head>
  <body style="margin:0"><div id="panel" style="height:600px"></div><div id="calls"></div></body></html>`;

async function open(browser){
  const page = await browser.newPage({ viewport: { width: 433, height: 870 } });
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  await page.route(`${ORIGIN}/**`, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: PAGE });
    const name = url.pathname.split('/').pop();
    if (name === 'communications.css') { await held; return route.fulfill({ contentType: 'text/css', body: file(name) }); }
    return route.fulfill({ contentType: 'text/javascript', body: file(name) });
  });
  await page.goto(`${ORIGIN}/`, { waitUntil: 'domcontentloaded' });
  return { page, release };
}

const visible = (page, selector) => page.evaluate((s) => { const el = document.querySelector(s); return !!el && getComputedStyle(el).display !== 'none' && el.getBoundingClientRect().height > 0; }, selector);

test('the project Comms tab is styled before mount and loads until communications.css has', async () => {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  try {
    const { page, release } = await open(browser);
    assert.equal(await page.evaluate(() => Portal.CommunicationsUI.cssLoaded()), false);
    // What the project window paints before mount: the tab's styles are in and its shell is hidden.
    await page.evaluate(() => { document.getElementById('panel').innerHTML = window.__commsApp.panelHtml({}); });
    assert.equal(await page.evaluate(() => !!document.getElementById('css_project_comms') || [...document.querySelectorAll('style')].some((s) => s.textContent.includes('.fmco-shell{'))), true, 'panelHtml injects the tab styles');
    assert.equal(await visible(page, '[data-comms-root]'), false, 'the pre-mount shell is hidden');
    // Mounted: the header shows, the content is the tab's own loading state until communications.css arrives.
    await page.evaluate(() => { const api = window.__commsApp.mount({ panelRoot: document.getElementById('panel'), projectId: 'project_1' }); api.render(); });
    assert.equal(await visible(page, '[data-comms-root]'), true);
    assert.equal(await visible(page, '[data-co-content] > .fmco-empty[data-co-css-wait]'), true, 'loading while the stylesheet is held');
    assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.fmco-search')).borderTopStyle), 'solid', 'the header is styled');
    release();
    await page.waitForFunction(() => Portal.CommunicationsUI.cssLoaded() && !document.querySelector('[data-co-css-wait]'));
  } finally {
    await browser.close();
  }
});

test('Communications (Calls) shows a styled loading state until communications.css has loaded', async () => {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  try {
    const { page, release } = await open(browser);
    await page.evaluate(() => { window.CommsAPI = { customer: () => new Promise(() => {}) }; Portal.CommunicationsWorkspace.mount(document.getElementById('calls'), { projectId: 'project_1' }); });
    assert.equal(await visible(page, '#calls > .fmcm'), false, 'nothing drawn with communications.css shows yet');
    assert.equal(await visible(page, '#calls > [data-fmcm-css-wait]'), true, 'a loading state shows instead');
    assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('[data-fmcm-css-wait]')).justifyContent), 'center', 'and it is styled inline');
    release();
    await page.waitForFunction(() => !document.querySelector('[data-fmcm-css-wait]'));
    assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('#calls > .fmcm')).display !== 'none'), true);
  } finally {
    await browser.close();
  }
});
