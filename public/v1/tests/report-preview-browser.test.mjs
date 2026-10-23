import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile, access} from 'node:fs/promises';
import {chromium} from 'playwright-core';

const lib = new URL('../../libraries/apps/settings/', import.meta.url);
const source = await readFile(new URL('report-preview.js', lib), 'utf8');
const ALL = {cover_show_customer:true, cover_show_squares:true, cover_show_waste:true, cover_show_breakdown:true, cover_show_pitch:true, cover_show_facets:true, page_top_view:true, page_3d:true, page_pitch:true, page_area:true, page_layers:true, page_summary:true, page_materials:true, page_ventilation:true, page_notes:true, page_gutters:false};

test('the report preview shows every page of the customer and internal PDFs and follows the customer settings', async () => {
  assert.doesNotMatch(source, /[^\x00-\x7F]/, 'the file stays ASCII so it reads the same in any charset');
  for (const name of ['outline', 'imagery', 'view-north', 'view-south', 'view-east', 'view-west', 'pitch', 'area', 'layer', 'summary-outline', 'ventilation', 'gutters', 'notes']) {
    assert.ok(source.includes(`'${name}'`) || name.startsWith('view-'), name);
    await access(new URL(`report-preview/${name}.webp`, lib));
  }
  const browser = await chromium.launch({channel:'chrome', headless:true});
  try {
    const page = await browser.newPage({viewport:{width:900, height:1000}});
    await page.setContent('<div id="host" style="width:640px;height:900px"></div>');
    await page.addScriptTag({content:source});
    const state = (settings) => page.evaluate((settings) => {
      window.FirstMateReportPreview.render(document.querySelector('#host'), {settings});
      const host = document.querySelector('#host');
      return {
        mode:host.querySelector('[aria-selected=true]')?.dataset.rpvMode,
        sheets:host.querySelectorAll('[data-rpv-viewer] .rpv-sheet').length,
        thumbs:[...host.querySelectorAll('.rpv-thumb > span')].map((s) => s.textContent),
        cover:host.querySelector('[data-rpv-sheet="0"]').textContent
      };
    }, settings);
    // The organization's colour and logo brand the customer PDF only.
    await page.evaluate(() => document.documentElement.style.setProperty('--primary', 'rgb(30, 136, 229)'));
    const branding = () => page.evaluate(() => { const sheet = document.querySelector('[data-rpv-viewer] [data-rpv-sheet="0"] .rpv-page'); return {unbranded:sheet.classList.contains('rpv-unbranded'), sidebar:getComputedStyle(sheet.querySelector('.rpv-b')).backgroundColor, logo:sheet.querySelector('.rpv-logo')?.getAttribute('src') || 'default'}; });
    await page.evaluate((settings) => window.FirstMateReportPreview.render(document.querySelector('#host'), {settings, logo:'/org-logo.png'}), ALL);
    assert.deepEqual(await branding(), {unbranded:false, sidebar:'rgb(30, 136, 229)', logo:'/org-logo.png'});
    const full = await state(ALL);
    assert.equal(full.mode, 'customer');
    // A roof-only report keeps the original page order: the diagrams come before the summary and materials.
    assert.deepEqual(full.thumbs, ['Cover', 'Imagery', 'Facets', 'Pitch', 'Area', 'Layer 1', 'Summary', 'Materials', 'Materials', 'Flat Roof', 'Ventilation', 'Notes']);
    assert.equal(full.sheets, full.thumbs.length);
    assert.match(full.cover, /PREPARED FOR[\s\S]*Homeowner[\s\S]*Total Squares \(\+14% Waste\)[\s\S]*55\.32/);
    // Turning settings off takes their pages and cover details out; gutters come in when chosen.
    const trimmed = await state({...ALL, cover_show_customer:false, cover_show_waste:false, page_materials:false, page_ventilation:false, page_gutters:true});
    assert.deepEqual(trimmed.thumbs, ['Cover', 'Imagery', 'Facets', 'Pitch', 'Area', 'Layer 1', 'Summary', 'Gutters', 'Notes']);
    assert.doesNotMatch(trimmed.cover, /PREPARED FOR|Waste/);
    assert.match(trimmed.cover, /Total Squares[\s\S]*48\.53/);
    // The internal PDF has every page and the fixed two-box cover, whatever the customer settings say.
    await page.locator('[data-rpv-mode="internal"]').click();
    const internal = await page.evaluate(() => ({thumbs:document.querySelectorAll('[data-rpv-thumb]').length, cover:document.querySelector('[data-rpv-sheet="0"]').textContent, title:document.querySelector('[data-rpv-sheet="1"]').textContent}));
    assert.equal(internal.thumbs, 13);
    // Internal PDFs are not branded: FirstMate's red and logo whatever the organization's branding.
    await page.evaluate((settings) => window.FirstMateReportPreview.render(document.querySelector('#host'), {settings, logo:'/org-logo.png'}), ALL);
    assert.deepEqual(await branding(), {unbranded:true, sidebar:'rgb(200, 40, 40)', logo:'/images/logo_red.png'});
    // There is no elevations page; the 3D views page carries the roof-only title, 3D Facets.
    assert.match(await page.evaluate(() => document.querySelector('[data-rpv-sheet="2"]').textContent), /3D Facets[\s\S]*North View/);
    assert.match(internal.cover, /PROJECT SUMMARY[\s\S]*Total Squares \(14% Waste\): 55\.32[\s\S]*MEASUREMENT BREAKDOWN/);
    assert.match(internal.title, /Top View[\s\S]*Page 2/);
    // Paging: a thumbnail opens its page and the counter follows.
    await page.locator('[data-rpv-thumb="5"]').click();
    assert.equal(await page.locator('[data-rpv-count]').textContent(), 'Page 6 of 13');
    assert.equal(await page.locator('[data-rpv-thumb][aria-current=true]').getAttribute('data-rpv-thumb'), '5');
    await page.locator('[data-rpv-step="1"]').click();
    assert.equal(await page.locator('[data-rpv-count]').textContent(), 'Page 7 of 13');
  } finally { await browser.close(); }
});

test('the report preview lays every page out in landscape when the organization chooses landscape pages', async () => {
  const browser = await chromium.launch({channel:'chrome', headless:true});
  try {
    const page = await browser.newPage({viewport:{width:1100, height:900}});
    await page.setContent('<div id="host" style="width:900px;height:800px"></div>');
    await page.addScriptTag({content:source});
    const layout = (orientation, mode = 'customer') => page.evaluate(async ({orientation, mode}) => {
      const host = document.querySelector('#host');
      const view = window.FirstMateReportPreview.render(host, {settings:{}, orientation});
      view.setMode(mode);
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return [...host.querySelectorAll('[data-rpv-viewer] .rpv-sheet')].map((sheet) => {
        const pageEl = sheet.querySelector('.rpv-page'), box = pageEl.getBoundingClientRect(), footer = box.top + (box.height * (1 - 16 / (box.height > box.width ? 279.4 : 215.9)));
        // Everything drawn stays on the page and, except the footer line itself, above it.
        const outside = [...pageEl.querySelectorAll('.rpv-t,.rpv-p,.rpv-b,.rpv-i')].filter((el) => {
          const r = el.getBoundingClientRect();
          if (!r.width || !r.height || r.height > box.height * 0.95) return false; // the sidebar runs the full height
          const isFooter = el.classList.contains('rpv-t') && Math.abs(r.bottom - footer) < 2 * box.width / (box.width > box.height ? 279.4 : 215.9);
          return r.left < box.left - 1 || r.right > box.right + 1 || r.top < box.top - 1 || (!isFooter && r.bottom > footer + 3 * box.width / (box.width > box.height ? 279.4 : 215.9));
        }).map((el) => (el.textContent || el.className).slice(0, 40));
        return {label:sheet.getAttribute('aria-label'), wide:box.width > box.height, outside};
      });
    }, {orientation, mode});
    for (const mode of ['customer', 'internal']) {
      const landscape = await layout('landscape', mode);
      assert.ok(landscape.length >= 12, mode);
      for (const sheet of landscape) { assert.ok(sheet.wide, sheet.label + ' is landscape'); assert.deepEqual(sheet.outside, [], sheet.label + ' stays on the page, above the footer'); }
    }
    const portrait = await layout('portrait');
    assert.ok(portrait.every((sheet) => !sheet.wide), 'portrait by default');
  } finally { await browser.close(); }
});

test('only an organization with Full Exterior reports can switch the sample to a Full Exterior report', async () => {
  const browser = await chromium.launch({channel:'chrome', headless:true});
  try {
    const page = await browser.newPage({viewport:{width:900, height:1000}});
    await page.setContent('<div id="host" style="width:640px;height:900px"></div>');
    await page.addScriptTag({content:source});
    const switchShown = (exteriors) => page.evaluate((exteriors) => {
      const host = document.querySelector('#host');
      window.FirstMateReportPreview.render(host, {settings:{}, exteriors});
      const samples = host.querySelector('[data-rpv-samples]');
      return {hidden:samples.hidden, selected:samples.querySelector('[aria-selected=true]')?.dataset.rpvSample, sheets:host.querySelectorAll('[data-rpv-viewer] .rpv-sheet').length};
    }, exteriors);
    const off = await switchShown(false);
    assert.equal(off.hidden, true, 'no switch without Full Exterior reports');
    assert.ok(off.sheets > 1, 'the roof sample still shows');
    const on = await switchShown(true);
    assert.deepEqual([on.hidden, on.selected], [false, 'roof'], 'the switch shows, starting on the roof sample');
    assert.ok(source.includes("full-exterior-sample.json"), 'the Full Exterior sample is a saved full-house report');
    await access(new URL('report-preview/full-exterior-sample.json', lib));
  } finally { await browser.close(); }
});
