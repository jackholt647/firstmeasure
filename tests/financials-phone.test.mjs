import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// GP-134: Financials has its own phone layout; a desktop renders as before.
const app = readFileSync(new URL('../public/libraries/apps/financials/app.js', import.meta.url), 'utf8');
const widgets = readFileSync(new URL('../public/libraries/payments-widgets/payments-widgets.js', import.meta.url), 'utf8');
const company = readFileSync(new URL('../public/libraries/apps/settings/company.js', import.meta.url), 'utf8');

const between = (text, start, end) => text.slice(text.indexOf(start), text.indexOf(end, text.indexOf(start)));
const phoneCss = () => between(app, '/* GP-134: the phone layout.', '\n    `;');

test('a phone switches at the width the shared app chrome does', () => {
  assert.match(app, /const phoneQuery = window\.matchMedia\?\.\('\(max-width:800px\)'\);/);
  assert.match(phoneCss(), /@media\(max-width:800px\)\{/);
  assert.ok(app.indexOf('/* GP-134: the phone layout.') > app.indexOf('@media(max-width:720px){.fn-top'), 'the phone rules come after the older narrow-width rules, so they win');
});

test('on a phone the header is the shared tab strip with Settings at its end, never a second title', () => {
  const header = between(app, '    function headerHtml(){', '    function projectNames(');
  assert.match(header, /if \(isPhone\(\)\) return phoneHeaderHtml\(\);/);
  const phone = between(app, '    function phoneHeaderHtml(){', '    function headerHtml(){');
  assert.match(phone, /window\.AppChrome\.tabs\('financials', state\.view, 'data-fn-view', context, \{ strip:true, extra:\[settingsTab\] \}\)/);
  assert.match(phone, /attribute:'data-fn-settings'/);
  assert.doesNotMatch(phone, /tabs:/, 'no desktop pills or Day / Week / Month segment on a phone');
  const css = phoneCss();
  assert.match(css, /\.fn-shell>\[data-app-header="shared"\] \.app-heading[^{]*\{display:none\}/, 'the portal top bar names the app');
  assert.match(css, /\.fn-shell>\[data-app-header="shared"\]:not\(:has\(app-tab-strip\)\)\{display:none!important\}/);
});

test('phone figures sit in one row, with short labels and short amounts', () => {
  assert.match(phoneCss(), /\.fn-metrics,\.fn-metrics\.cash\{display:grid;grid-auto-flow:column;/);
  const metric = between(app, '    function metricHtml(', '    // Today ◀ ▶');
  assert.match(metric, /isPhone\(\)/);
  for (const short of ['Projected profit', 'Profit to date', 'Owed', 'Revenue', 'Available', 'Expected', 'Safe to spend', 'Pending', 'Undated', 'To review', 'Reviewed', 'No project', 'All']) {
    assert.ok(app.includes(`short:'${short}'`), `short label ${short}`);
  }
  const body = between(app, '  function moneyShort(value){', '  function percent(');
  const moneyShort = new Function('number', `${body}; return moneyShort;`)((value) => Math.round(Number(value) || 0));
  assert.equal(moneyShort(0), '$0');
  assert.equal(moneyShort(95000), '$950');
  assert.equal(moneyShort(4823400), '$48.2K');
  assert.equal(moneyShort(-210000), '-$2.1K');
});

test('phone lists replace the wide tables, and their cards keep the same actions', () => {
  assert.match(app, /activeRows\.length && isPhone\(\) \? `\$\{projectListHtml\(activeRows\)\}/);
  assert.match(app, /isPhone\(\) \? cycleListHtml\(cycles, maxProfit\)/);
  assert.match(app, /uncleared\.length && isPhone\(\) \? reconcileListHtml\(uncleared, false\)/);
  assert.match(app, /rows\.length && isPhone\(\) \? receiptListHtml\(rows\)/);
  assert.match(between(app, '    function projectListHtml(', '    function cycleListHtml('), /class="fn-prow" data-project-id=/);
  assert.match(between(app, '    function receiptListHtml(', '    function settingsModalHtml('), /data-fn-receipt="/);
  assert.match(app, /root\.querySelectorAll\('\[data-fn-receipt\]'\)/, 'receipt cards open like table rows');
  assert.match(app, /data-fn-grain-select/);
  assert.match(app, /root\.querySelector\('\[data-fn-grain-select\]'\)\?\.addEventListener\('change'/);
});

test('the payments widgets turn their tables into cards only for a host that asks (Financials, not Settings › Money)', () => {
  assert.match(widgets, /root\.className = `pmw pmw-payouts\$\{options\.phoneCards \? ' pmw-phone-cards' : ''\}`;/);
  assert.match(widgets, /root\.className = `pmw pmw-disputes\$\{options\.phoneCards \? ' pmw-phone-cards' : ''\}`;/);
  assert.match(widgets, /@media\(max-width:800px\)\{\s*\.pmw-phone-cards /);
  assert.equal((app.match(/phoneCards:true/g) || []).length, 2);
  assert.doesNotMatch(company, /phoneCards/);
});
