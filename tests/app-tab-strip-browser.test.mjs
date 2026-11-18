// FM-550: global apps' sub-tabs are one shared tab strip (AppChrome.tabStrip in app-runtime/app-chrome.js), a
// full-width row of icon + label tabs like the project view. When the full labels do not fit it shows each tab's
// short label, then icons only; under 600 px every tab gets an equal column with its label under the icon.
// Runs the real library in Chromium with a stubbed app runtime.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const { chromium } = createRequire(new URL('../public/v1/package.json', import.meta.url))('playwright-core');
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const SOURCE = readFileSync(new URL('../public/libraries/app-runtime/app-chrome.js', import.meta.url), 'utf8');

const STUB = `
  const apps = new Map();
  window.FirstMateEmbeddableApps = {
    escapeHtml: value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[c]),
    getApp: id => apps.get(id), registerApp: app => apps.set(app.id, app), evaluateAccess: () => ({ allowed:true })
  };
  window.FirstMateEmbeddableApps.registerApp({ id:'portal.demo', title:'Demo', order:10 });`;

const ITEMS = [
  { id:'inbox', title:'Inbox', icon:'fa-inbox' },
  { id:'lists', title:'Call lists', short:'Lists', icon:'list-check' },
  { id:'followups', title:'Follow-ups', short:'Follow', icon:'fa-calendar-check' },
  { id:'history', title:'History', icon:'fa-clock-rotate-left' },
  { id:'scripts', title:'Call scripts', short:'Scripts', icon:'fa-file-lines' },
  { id:'setup', title:'Settings', icon:'fa-gear', attribute:'data-settings' }
];

async function open(browser) {
  const page = await browser.newPage({ viewport: { width: 1200, height: 700 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.setContent('<!doctype html><html><head></head><body style="margin:0;font-family:Arial"><div id="host"></div></body></html>');
  await page.addScriptTag({ content: STUB });
  await page.addScriptTag({ content: SOURCE });
  return { page, errors };
}

// Renders the strip into a host of the given width and reads what each tab shows once it has been fitted.
const render = (page, width, items = ITEMS) => page.evaluate(async ({ width, items }) => {
  const host = document.getElementById('host');
  host.style.width = `${width}px`;
  host.innerHTML = window.AppChrome.tabStrip({ label:'Demo', attribute:'data-view', selected:'lists', items });
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const strip = host.querySelector('app-tab-strip');
  const visible = el => !!el && getComputedStyle(el).display !== 'none' && el.getClientRects().length > 0;
  return {
    fit: strip.dataset.fit, stacked: 'stacked' in strip.dataset,
    overflow: strip.scrollWidth > strip.clientWidth + 1,
    tabs: [...strip.querySelectorAll('button')].map(button => ({
      text: [...button.querySelectorAll('.app-tab-long,.app-tab-short')].filter(visible).map(el => el.textContent).join(''),
      icon: visible(button.querySelector('i')), current: button.getAttribute('aria-current'), name: button.getAttribute('aria-label'),
      direction: getComputedStyle(button).flexDirection, tooltip: button.getAttribute('data-fm-tooltip')
    }))
  };
}, { width, items });

test('a wide strip shows every icon and full label, the selected tab current', async () => {
  const browser = await chromium.launch({ executablePath: CHROME });
  try {
    const { page, errors } = await open(browser);
    const strip = await render(page, 1100);
    assert.equal(strip.fit, 'full');
    assert.equal(strip.stacked, false);
    assert.deepEqual(strip.tabs.map(t => t.text), ['Inbox', 'Call lists', 'Follow-ups', 'History', 'Call scripts', 'Settings']);
    assert.ok(strip.tabs.every(t => t.icon && t.direction === 'row' && !t.tooltip));
    assert.deepEqual(strip.tabs.map(t => t.current), ['false', 'page', 'false', 'false', 'false', 'false']);
    // Each tab carries its id in the strip's attribute or its own, and keeps its full name for assistive technology.
    assert.equal(await page.locator('app-tab-strip [data-view="lists"]').count(), 1);
    assert.equal(await page.locator('app-tab-strip [data-settings="setup"]').count(), 1);
    assert.equal(await page.locator('app-tab-strip i.fas.fa-list-check').count(), 1, 'an icon without fa- gets it');
    assert.deepEqual(strip.tabs.map(t => t.name), ['Inbox', 'Call lists', 'Follow-ups', 'History', 'Call scripts', 'Settings']);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('when full labels do not fit, short labels; then icons only, named by tooltips', async () => {
  const browser = await chromium.launch({ executablePath: CHROME });
  try {
    const { page, errors } = await open(browser);
    const many = [...ITEMS, ...ITEMS.map(item => ({ ...item, id:`${item.id}-2`, attribute:'' }))];
    await render(page, 2400, many);
    // The strip's natural width with full and with short labels.
    const [full, short] = await page.evaluate(() => ['full', 'short'].map(fit => {
      const s = document.querySelector('app-tab-strip'); s.dataset.measure = ''; s.dataset.fit = fit;
      const width = s.getBoundingClientRect().width; delete s.dataset.measure; return width;
    }));
    assert.ok(short >= 620 && full > short + 40, `natural widths ${full} / ${short}`);
    const shortened = await render(page, Math.floor((full + short) / 2), many);
    assert.equal(shortened.fit, 'short');
    assert.equal(shortened.overflow, false);
    assert.deepEqual(shortened.tabs.slice(0, 6).map(t => t.text), ['Inbox', 'Lists', 'Follow', 'History', 'Scripts', 'Settings']);
    assert.ok(shortened.tabs.every(t => !t.tooltip));
    const icons = await render(page, Math.floor(short) - 10, many);
    assert.equal(icons.fit, 'icons');
    assert.equal(icons.stacked, false);
    assert.equal(icons.overflow, false);
    assert.ok(icons.tabs.every(t => t.icon && t.text === ''));
    assert.equal(icons.tabs[1].tooltip, 'Call lists');
    // Wide again: full labels come back and the tooltips go.
    const wide = await render(page, 1400, many);
    assert.equal(wide.fit, 'full');
    assert.ok(wide.tabs.every(t => !t.tooltip));
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('a phone-width strip stacks label under icon in equal columns, short once a full label is cut', async () => {
  const browser = await chromium.launch({ executablePath: CHROME });
  try {
    const { page, errors } = await open(browser);
    const roomy = await render(page, 560, ITEMS.slice(0, 3));
    assert.equal(roomy.stacked, true);
    assert.equal(roomy.fit, 'full');
    assert.ok(roomy.tabs.every(t => t.direction === 'column' && t.icon));
    const widths = await page.evaluate(() => [...document.querySelectorAll('app-tab-strip button')].map(b => Math.round(b.getBoundingClientRect().width)));
    assert.ok(Math.max(...widths) - Math.min(...widths) <= 1, `equal columns: ${widths}`);
    const phone = await render(page, 330);
    assert.equal(phone.stacked, true);
    assert.equal(phone.fit, 'short');
    assert.equal(phone.overflow, false);
    assert.deepEqual(phone.tabs.map(t => t.text), ['Inbox', 'Lists', 'Follow', 'History', 'Scripts', 'Settings']);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('the strip refits when its container is resized', async () => {
  const browser = await chromium.launch({ executablePath: CHROME });
  try {
    const { page, errors } = await open(browser);
    await render(page, 1100);
    await page.evaluate(() => { document.getElementById('host').style.width = '330px'; });
    await page.waitForFunction(() => document.querySelector('app-tab-strip').dataset.fit === 'short' && 'stacked' in document.querySelector('app-tab-strip').dataset);
    await page.evaluate(() => { document.getElementById('host').style.width = '1100px'; });
    await page.waitForFunction(() => document.querySelector('app-tab-strip').dataset.fit === 'full' && !('stacked' in document.querySelector('app-tab-strip').dataset));
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('group tabs render the strip only when asked; other apps keep the header pills', async () => {
  const browser = await chromium.launch({ executablePath: CHROME });
  try {
    const { page, errors } = await open(browser);
    const result = await page.evaluate(() => {
      window.AppChrome.registerGroup({ id:'demo', parent:'portal.demo', title:'Demo', icon:'fa-star', default:'a', mount(){},
        members:[{ id:'a', title:'Alpha view', short:'Alpha', icon:'fa-a' }, { id:'b', title:'Beta', icon:'fa-b' }] });
      const pills = window.AppChrome.tabs('demo', 'a', 'data-demo');
      const strip = window.AppChrome.tabs('demo', 'b', 'data-demo', {}, { strip:true, extra:[{ id:'setup', title:'Settings', icon:'fa-gear', attribute:'data-other' }] });
      const header = window.AppChrome.header({ title:'Demo', strip });
      return { pills, strip, header };
    });
    assert.match(result.pills, /^<nav class="app-tabs" aria-label="Demo"><button type="button" data-demo="a" aria-current="page">Alpha view<\/button>/);
    assert.match(result.strip, /^<app-tab-strip class="app-tabstrip" role="navigation" aria-label="Demo">/);
    assert.match(result.strip, /data-demo="a" aria-current="false" aria-label="Alpha view"><i class="fas fa-a" aria-hidden="true"><\/i><span class="app-tab-label"><span class="app-tab-long">Alpha view<\/span><span class="app-tab-short" aria-hidden="true">Alpha<\/span>/);
    assert.match(result.strip, /data-demo="b" aria-current="page"/);
    assert.match(result.strip, /data-other="setup" aria-current="false" aria-label="Settings"><i class="fas fa-gear"/);
    // The strip sits under the header, full width, not among the header's tools.
    assert.match(result.header, /<\/header><app-tab-strip /);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
