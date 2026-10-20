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
    // A roof-only report keeps the original titles and order: no elevations page, so the 3D views page is "3D Facets",
    // and the diagrams come before the summary.
    assert.match(await page.evaluate(() => document.querySelector('[data-rpv-sheet="2"]').textContent), /3D Facets[\s\S]*North View/);
    assert.match(await page.evaluate(() => document.querySelector('[data-rpv-sheet="3"]').textContent), /Pitch Diagram/);
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
