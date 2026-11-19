// GP-74: in the collapsed left column an app's tooltip is its name, and its Setup or New pill shows as a pill
// beside the name, never as text glued onto it ("FinancialsSetup"). The pills carry data-fm-tooltip-pill
// (public/portal/scripts/core.js); the tooltip is built in public/libraries/platform-ui/platform-ui.js.
// Runs the real library in Chromium on a minimal compact sidebar.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const { chromium } = createRequire(new URL('../public/v1/package.json', import.meta.url))('playwright-core');
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const SOURCE = readFileSync(new URL('../public/libraries/platform-ui/platform-ui.js', import.meta.url), 'utf8');
const CORE = readFileSync(new URL('../public/portal/scripts/core.js', import.meta.url), 'utf8');

const SIDEBAR = `
  <nav id="mainSidebar" class="sidebar-instant-tooltips sidebar-compact" style="width:72px">
    <div class="fm-link" id="money"><div class="ic"><i class="fas" style="display:inline-block;width:20px;height:20px"></i></div><div class="tx">Financials<span class="fm-global-app-new fm-global-app-pill--setup" data-fm-tooltip-pill="setup">Setup</span></div></div>
    <div class="fm-link" id="comms"><div class="ic"><i class="fas" style="display:inline-block;width:20px;height:20px"></i></div><div class="tx">Comms &lt;b&gt;<span class="fm-global-app-new" data-fm-tooltip-pill="new">New</span></div></div>
    <div class="fm-link" id="projects"><div class="ic"><i class="fas" style="display:inline-block;width:20px;height:20px"></i></div><div class="tx">Projects</div></div>
    <button type="button" id="more" title="More apps" aria-label="More apps (New)"><span class="tx">More apps<span class="fm-global-app-new" data-fm-tooltip-pill="new">New</span></span></button>
  </nav>`;

async function hover(page, id) {
  await page.mouse.move(600, 600);
  await page.hover(`#${id} .ic, #${id} .tx`);
  await page.waitForFunction(() => document.getElementById('fmTooltip')?.classList.contains('visible'));
  return page.evaluate(() => {
    const tip = document.getElementById('fmTooltip');
    const pills = [...tip.querySelectorAll('.fm-tooltip-pill')].map((pill) => ({
      text: pill.textContent, kind: pill.dataset.kind, background: getComputedStyle(pill).backgroundColor,
      radius: parseFloat(getComputedStyle(pill).borderTopLeftRadius)
    }));
    const name = [...tip.childNodes].filter((node) => node.nodeType === 3).map((node) => node.textContent).join('');
    return { name, pills, html: tip.innerHTML };
  });
}

test('collapsed sidebar tooltips show Setup and New as pills beside the name', async () => {
  const browser = await chromium.launch({ executablePath: CHROME });
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 700 } });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.setContent(`<!doctype html><html><head></head><body style="margin:0">${SIDEBAR}</body></html>`);
    await page.addScriptTag({ content: SOURCE });

    const money = await hover(page, 'money');
    assert.equal(money.name, 'Financials');
    assert.deepEqual(money.pills.map(({ text, kind }) => ({ text, kind })), [{ text: 'Setup', kind: 'setup' }]);
    assert.equal(money.pills[0].background, 'rgb(255, 240, 203)');
    assert.ok(money.pills[0].radius > 8, 'the pill is rounded like the sidebar pill');

    const comms = await hover(page, 'comms');
    assert.equal(comms.name, 'Comms <b>', 'the name is text, not markup');
    assert.deepEqual(comms.pills.map(({ text, kind }) => ({ text, kind })), [{ text: 'New', kind: 'new' }]);
    assert.equal(comms.pills[0].background, 'rgb(232, 245, 238)');

    const projects = await hover(page, 'projects');
    assert.equal(projects.name, 'Projects');
    assert.deepEqual(projects.pills, []);

    const more = await hover(page, 'more');
    assert.equal(more.name, 'More apps');
    assert.deepEqual(more.pills.map(({ text }) => text), ['New']);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});

test('the left column and the More apps launcher mark their pills for the tooltip', () => {
  assert.match(CORE, /class="fm-global-app-new fm-global-app-pill--\$\{[^}]+\}" data-fm-tooltip-pill="/);
  assert.match(CORE, /pill\.dataset\.fmTooltipPill = 'new';/);
});
