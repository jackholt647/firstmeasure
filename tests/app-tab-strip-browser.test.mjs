// FM-550: global apps' sub-tabs are one shared tab strip (AppChrome.tabStrip in app-runtime/app-chrome.js), a
// full-width row of icon + label tabs like the project view. When the full labels do not fit it shows each tab's
// short label, then icons only; on a phone, under 600 px every tab gets an equal column with its label under the icon.
// GP-63: on a desktop it is a segmented control like My Projects' and My Contacts' views, beside the header's title.
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

async function open(browser, width = 1200) {
  const page = await browser.newPage({ viewport: { width, height: 700 } });
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
    const { page, errors } = await open(browser, 700);
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
    const { page, errors } = await open(browser, 700);
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
    // The strip is in the header, beside the title (GP-63), not among the header's tools.
    assert.match(result.header, /<\/h1><\/div><\/div><div class="app-header-strip"><app-tab-strip [^]*<\/app-tab-strip><\/div><div class="app-header-tools"><\/div><\/header>$/);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

// GP-63: what a header with a strip looks like at a viewport width, once fitted.
const renderHeader = (page, width) => page.evaluate(async width => {
  const host = document.getElementById('host');
  host.style.width = `${width}px`;
  host.innerHTML = window.AppChrome.header({ title:'Communications', icon:'fa-comments',
    strip: window.AppChrome.tabStrip({ label:'Demo', attribute:'data-view', selected:'lists', items: [
      { id:'inbox', title:'Inbox', icon:'fa-inbox' }, { id:'lists', title:'Call lists', short:'Lists', icon:'list-check' },
      { id:'history', title:'History', icon:'fa-clock-rotate-left' }, { id:'setup', title:'Settings', icon:'fa-gear' }] }) });
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const header = host.querySelector('header'), title = header.querySelector('h1'), strip = header.querySelector('app-tab-strip');
  const buttons = [...strip.querySelectorAll('button')], box = el => el.getBoundingClientRect(), css = el => getComputedStyle(el);
  return {
    fit: strip.dataset.fit, stacked: 'stacked' in strip.dataset, overflow: strip.scrollWidth > strip.clientWidth + 1,
    header: box(header).toJSON(), title: box(title).toJSON(), strip: box(strip).toJSON(),
    first: box(buttons[0]).toJSON(), last: box(buttons.at(-1)).toJSON(),
    radius: [css(buttons[0]).borderTopLeftRadius, css(buttons.at(-1)).borderBottomRightRadius],
    border: css(buttons[1]).borderTopWidth, stripBorder: css(strip).borderTopWidth,
    current: css(buttons[1]).backgroundImage, other: css(buttons[0]).backgroundImage, shadow: css(buttons[1]).boxShadow
  };
}, width);

test('on a desktop the strip is a segmented control beside the title, right-aligned, and never stacks', async () => {
  const browser = await chromium.launch({ executablePath: CHROME });
  try {
    const { page, errors } = await open(browser, 1200);
    const wide = await renderHeader(page, 1100);
    assert.equal(wide.fit, 'full');
    assert.equal(wide.stacked, false);
    const middle = value => value.top + value.height / 2;
    assert.ok(Math.abs(middle(wide.first) - middle(wide.title)) < 6, 'tabs on the title row');
    assert.ok(wide.first.left > wide.title.right, 'tabs after the title');
    assert.ok(Math.abs(wide.header.right - 22 - wide.last.right) <= 1, `right-aligned: ${wide.last.right} in ${wide.header.right}`);
    assert.deepEqual(wide.radius, ['10px', '10px']);
    assert.equal(wide.border, '1px');
    assert.equal(wide.stripBorder, '0px');
    assert.match(wide.current, /gradient/, 'the current tab is tinted');
    assert.equal(wide.other, 'none');
    assert.equal(wide.shadow, 'none', 'no underline');
    // Little room beside the title: icons only, still on one row, never the phone's stacked columns.
    const narrow = await renderHeader(page, 520);
    assert.equal(narrow.stacked, false);
    assert.equal(narrow.fit, 'icons');
    assert.equal(narrow.overflow, false);
    assert.ok(Math.abs(middle(narrow.first) - middle(narrow.title)) < 6);
    // And the labels come back when there is room again.
    assert.equal((await renderHeader(page, 1100)).fit, 'full');
    // A strip outside a header, under 600 px, does not stack on a desktop either.
    assert.equal((await render(page, 560, ITEMS.slice(0, 3))).stacked, false);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('on a phone the header strip is the full-width row under the title', async () => {
  const browser = await chromium.launch({ executablePath: CHROME });
  try {
    const { page, errors } = await open(browser, 390);
    const phone = await renderHeader(page, 390);
    assert.equal(phone.stacked, true);
    assert.ok(phone.strip.top >= phone.title.bottom, 'under the title');
    assert.equal(Math.round(phone.strip.left), Math.round(phone.header.left));
    assert.equal(Math.round(phone.strip.width), Math.round(phone.header.width));
    assert.equal(Math.round(phone.strip.bottom), Math.round(phone.header.bottom), 'the header ends with the strip');
    assert.equal(phone.stripBorder, '1px');
    assert.equal(phone.border, '0px');
    assert.notEqual(phone.shadow, 'none', 'the current tab is underlined');
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
