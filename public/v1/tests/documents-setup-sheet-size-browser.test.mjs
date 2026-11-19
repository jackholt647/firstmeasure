// GP-23: the document setup's wide steps (style, prices, wording, first proposal: documents-setup.js adds `gxs-wide`)
// take the project window's size. On the page that is the window manager's modal (min(1720, 96vw) x min(1180, 92vh),
// centred, window-manager.js), inside a project window the whole window. Other setups keep the player's wide sheet
// (guided-setup.js), and a phone keeps the player's sheet. The real player plays a real documents-setup.js step.
import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright-core';

const lib = (file) => readFile(new URL('../../libraries/' + file, import.meta.url), 'utf8');
const LIBS = ['navigation/portal-navigation.js', 'guided-experiences/guided-experiences.js', 'guided-experiences/guided-setup.js'];
const t = (key, text) => ({ key, text });
const setup = (id) => ({ id, version: 1, kind: 'modal', scope: 'organization', title: t('gx_ts_title', 'Size test'), tab: '', replayable: true,
  steps: [{ id: 'kind', widget: 'module', module: '/libraries/guided-experiences/documents-setup.js', options: { part: 'kind' }, title: t('gx_ts_kind', 'Kind'), required: false }],
  completion: { action: null, screen: 'none', say: [], then: [] }, triggers: [], progress: null });
const page = (embedded) => `<!doctype html><html${embedded ? ' class="project-window-embedded"' : ''}><head><style>body{margin:0;font:14px Arial}*{transition:none!important;animation:none!important}</style></head><body>
  <script>window.__APP={userOrgId:'o',platformApiBase:'https://fm.test/v1/platform'};</script>
  ${LIBS.map((file) => `<script src="/libraries/${file}"></script>`).join('')}
  </body></html>`;

async function sheet(browser, { id, embedded = false, width = 1440, height = 900 }){
  const tab = await browser.newPage({ viewport: { width, height } }), errors = [];
  tab.on('pageerror', (error) => errors.push(error.message));
  await tab.route('https://fm.test/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.startsWith('/libraries/')) return route.fulfill({ contentType: 'text/javascript', body: await lib(url.pathname.slice(11)) });
    if (url.pathname === '/portal/') return route.fulfill({ contentType: 'text/html', body: page(embedded) });
    if (url.pathname.endsWith('/experiences')) return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, experiences: [setup(id)], reveals: [], faqs: null }) });
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true }) });
  });
  await tab.goto('https://fm.test/portal/');
  await tab.evaluate((id) => { FirstMateGuides.play(id, { replay: true }); }, id);
  await tab.waitForSelector('.gxd-tile');
  // The style, price, wording and first-proposal steps widen the sheet this way.
  await tab.evaluate(() => document.querySelector('.gxs').classList.add('gxs-wide'));
  await tab.waitForTimeout(100);
  const box = await tab.evaluate(() => { const s = document.querySelector('.gxs-sheet'), r = s.getBoundingClientRect(); return { rect: [r.left, r.top, r.width, r.height].map(Math.round), radius: getComputedStyle(s).borderTopLeftRadius }; });
  await tab.close();
  assert.deepEqual(errors, []);
  return box;
}

test('the document setup\'s wide sheet is the project window\'s size', async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
  try {
    // On the page: the window manager's modal, centred (at 1440 x 900, 96% x 92%).
    const w = Math.round(Math.min(1720, 1440 * .96)), h = Math.round(Math.min(1180, 900 * .92));
    assert.deepEqual(await sheet(browser, { id: 'documents.setup' }), { rect: [Math.round((1440 - w) / 2), Math.round((900 - h) / 2), w, h], radius: '12px' });
    // A big screen: capped as the project window is.
    assert.deepEqual((await sheet(browser, { id: 'documents.setup', width: 2560, height: 1440 })).rect.slice(2), [1720, 1180]);
    // Inside a project window (an iframe of the portal): the whole window.
    assert.deepEqual(await sheet(browser, { id: 'documents.setup', embedded: true, width: 1361, height: 826 }), { rect: [0, 0, 1361, 826], radius: '0px' });
    // Another setup's wide sheet is the player's (min(1480, 100vw - 32) x min(880, 100vh - 32)).
    assert.deepEqual(await sheet(browser, { id: 'test.other_setup' }), { rect: [16, 16, 1408, 868], radius: '20px' });
    // A phone keeps the player's sheet: the screen's width, from the bottom edge.
    const [left, top, width, height] = (await sheet(browser, { id: 'documents.setup', width: 390, height: 800 })).rect;
    assert.deepEqual([left, width, top + height], [0, 390, 800]);
  } finally { await browser.close(); }
});
