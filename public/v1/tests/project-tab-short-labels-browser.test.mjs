/* Project window tabs that run out of room (FM-371): full labels first, then the short names of the
 * tabs that have one (Documents -> Docs, Operations -> Ops, Financials -> Finance), and icons only when
 * even those do not fit. Runs the project window's own fit (app.js, observeProjectHeaderFit) and CSS
 * against the shared tab renderer, on a desktop header and on a phone.
 * Run: node --test tests/project-tab-short-labels-browser.test.mjs (CHROME_PATH to a Chromium). */
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright-core';

const file = path => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');
const app = await file('libraries/apps/project-request/app.js');
const fit = app.slice(app.indexOf('\n  function observeProjectHeaderFit('), app.indexOf('\n  function ensureProjectWindow('));
const windowCss = app.match(/injectCSS\('project-window', `([\s\S]*?)`\);/)[1];
const terminology = await file('libraries/platform-terminology/platform-terminology.js');
const chrome = () => chromium.launch({executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true});
const TABS = [['map', 'Overview', 'fa-map-location-dot'], ['measurements', 'Reports', 'fa-ruler-combined'], ['photos', 'Photos', 'fa-images'], ['docs', 'Documents', 'fa-folder-open', 'Docs'], ['materials', 'Operations', 'fa-clipboard-list', 'Ops'], ['money', 'Financials', 'fa-dollar-sign', 'Finance'], ['comms', 'Comms', 'fa-comments']];

async function header(page, {mobile, tabs = TABS}){
  await page.setContent('<meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;font-family:Arial}</style><div class="fm-entity-window r-overlay window-managed"><header class="r-modal-header r-window-bar fm-shell-header" data-header-rows="2" data-window-mobile="' + mobile + '"><div class="r-window-identity fm-shell-identity"><span>12 Main St</span></div><div class="r-tabbar fm-shell-tabs" id="rProjectViewerTabs"></div><div class="r-window-bar-actions"><div class="fm-window-controls"><button data-window-action="close">x</button></div></div></header></div>');
  await page.evaluate(() => { window.Portal = {}; });
  await page.addScriptTag({content: await file('portal/scripts/project_viewer.js')});
  await page.addScriptTag({content: await file('libraries/window-manager/window-shell.js')});
  await page.addStyleTag({content: windowCss});
  await page.evaluate(([fit, tabs]) => {
    window.FirstMateWindowShell?.ensureStyles?.();
    Portal.ProjectViewer.renderTabs(document.getElementById('rProjectViewerTabs'), tabs.map(([id, label, icon, shortLabel], index) => ({id, label, icon, shortLabel, active: index === 0})), {tabClass: 'r-tab'});
    window.observeProjectHeaderFit = new Function(`${fit}; return observeProjectHeaderFit;`)();
    window.observeProjectHeaderFit(document.querySelector('.r-overlay'));
  }, [fit, tabs]);
}
// The fit runs in the frame after a resize is observed: let a few frames pass first.
const state = page => page.evaluate(() => new Promise(done => {
  const frames = (count, then) => count ? requestAnimationFrame(() => frames(count - 1, then)) : then();
  frames(4, () => {
    const tabs = document.getElementById('rProjectViewerTabs');
    done({
      short: tabs.classList.contains('r-header-short'), icons: tabs.classList.contains('r-header-icons'),
      shown: [...tabs.querySelectorAll('.r-tab')].map(button => button.querySelector('.pv-tab-label')?.offsetWidth ? button.querySelector('.pv-tab-label').innerText.trim() : ''),
      names: [...tabs.querySelectorAll('.r-tab')].map(button => button.getAttribute('aria-label'))
    });
  });
}));

test('a tab with a short name carries both; the short one is hidden until the strip runs out of room', async () => {
  const browser = await chrome();
  try {
    const page = await browser.newPage({viewport: {width: 1600, height: 900}});
    await header(page, {mobile: false});
    const result = await state(page);
    assert.deepEqual(result, {short: false, icons: false, shown: TABS.map(tab => tab[1]), names: TABS.map(tab => tab[1])});
  } finally { await browser.close(); }
});

test('a narrowing desktop header goes full labels, then short labels, then icons only', async () => {
  const browser = await chrome();
  try {
    const page = await browser.newPage({viewport: {width: 1600, height: 900}});
    await header(page, {mobile: false});
    // The widths the strip needs with full and with short labels.
    const [full, short] = await page.evaluate(() => {
      const tabs = document.getElementById('rProjectViewerTabs');
      const width = mode => { tabs.classList.toggle('r-header-short', mode); return Math.ceil([...tabs.children].reduce((sum, button) => sum + button.getBoundingClientRect().width, 0)); };
      const result = [width(false), width(true)];
      tabs.classList.remove('r-header-short');
      return result;
    });
    assert.ok(short < full - 40, `short labels save room (${full} -> ${short})`);
    // Everything in the header beside the strip.
    const actions = await page.evaluate(() => innerWidth - document.getElementById('rProjectViewerTabs').clientWidth);
    const at = async strip => { await page.setViewportSize({width: Math.round(strip + actions), height: 900}); return state(page); };

    let result = await at(full + 20);
    assert.equal(result.short, false); assert.equal(result.icons, false);
    assert.deepEqual(result.shown, TABS.map(tab => tab[1]));

    result = await at((full + short) / 2);
    assert.equal(result.short, true, 'short labels before icons'); assert.equal(result.icons, false);
    assert.deepEqual(result.shown, TABS.map(tab => tab[3] || tab[1]));
    assert.deepEqual(result.names, TABS.map(tab => tab[1]), 'the full name stays the accessible name');

    result = await at(short - 30);
    assert.equal(result.icons, true, 'icons only once short labels do not fit either');
    assert.deepEqual(result.shown, TABS.map(() => ''));

    result = await at(full + 20);
    assert.equal(result.short, false, 'widening restores the full labels'); assert.equal(result.icons, false);
  } finally { await browser.close(); }
});

test('on a phone a tab whose full label is cut off under its icon switches the strip to short labels', async () => {
  const browser = await chrome();
  try {
    const page = await browser.newPage({viewport: {width: 360, height: 740}, isMobile: true, hasTouch: true});
    await header(page, {mobile: true});
    const result = await state(page);
    assert.equal(result.short, true);
    assert.deepEqual(result.shown, TABS.map(tab => tab[3] || tab[1]));
    const cut = await page.evaluate(() => [...document.querySelectorAll('#rProjectViewerTabs .pv-tab-label')].filter(label => label.scrollWidth > label.clientWidth + 1).map(label => label.innerText));
    assert.deepEqual(cut, [], 'no short label is cut off');
    // A phone wide enough for every full label keeps them.
    await page.setViewportSize({width: 900, height: 740});
    assert.equal((await state(page)).short, false);
  } finally { await browser.close(); }
});

// Jack's phone (FM-371, 11/11): seven tabs where "Documents" was cut off by less than a pixel, which the
// strip still draws with an ellipsis. A full label that shows cut off never stays while it has a short one.
test('on a phone a full label cut off by a fraction of a pixel still switches the strip to short labels', async () => {
  const tabs = [['photos', 'Photos', 'fa-images'], ['docs', 'Documents', 'fa-folder-open', 'Docs'], ['materials', 'Operations', 'fa-clipboard-list', 'Ops'], ['customer_portal', 'Portal', 'fa-link'], ['schedule', 'Schedule', 'fa-calendar-days'], ['money', 'Financials', 'fa-dollar-sign', 'Finance'], ['checklists', 'Checklists', 'fa-list-check']];
  const browser = await chrome();
  try {
    const page = await browser.newPage({viewport: {width: 400, height: 900}, deviceScaleFactor: 2.75, isMobile: true, hasTouch: true});
    await header(page, {mobile: true, tabs});
    const failures = [];
    for (let width = 380; width <= 480; width += 1) {
      await page.setViewportSize({width, height: 900});
      const result = await state(page);
      const cut = await page.evaluate(() => [...document.querySelectorAll('#rProjectViewerTabs .pv-tab-label:has(.pv-tab-short)')].filter(label => {
        const long = label.querySelector('.pv-tab-long');
        return long.getClientRects().length && long.getBoundingClientRect().width > label.getBoundingClientRect().width + 0.01;
      }).map(label => label.querySelector('.pv-tab-long').textContent));
      if (cut.length) failures.push(`${width}: ${cut.join(', ')} cut off (short ${result.short})`);
    }
    assert.deepEqual(failures, []);
  } finally { await browser.close(); }
});

test('the short name is the terminology term <key>_short, only where the library declares one', async () => {
  const browser = await chrome();
  try {
    const page = await browser.newPage();
    await page.route('**/v1/config-library/read/terminology_namespace', route => route.fulfill({json: {entries: [
      {id: 'documents', data: {terms: [{key: 'project_tab', label: 'Documents', kind: 'navigation'}, {key: 'project_tab_short', label: 'Docs', kind: 'navigation'}]}},
      {id: 'comms', data: {terms: [{key: 'project_tab', label: 'Comms', kind: 'navigation'}]}}
    ]}}));
    await page.route('http://terms.test/', route => route.fulfill({contentType: 'text/html', body: '<!doctype html><title>terms</title>'}));
    await page.goto('http://terms.test/');
    await page.addScriptTag({content: terminology});
    const labels = await page.evaluate(async () => {
      await PlatformTerminology.ready();
      return [PlatformTerminology.appShortLabel({terminologyKey: 'documents.project_tab'}), PlatformTerminology.appShortLabel({app: {terminologyKey: 'comms.project_tab'}}), PlatformTerminology.appShortLabel({})];
    });
    assert.deepEqual(labels, ['Docs', '', '']);
  } finally { await browser.close(); }
});
