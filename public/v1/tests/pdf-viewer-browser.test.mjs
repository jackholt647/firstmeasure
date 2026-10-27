// FirstMate PDF viewer (public/libraries/pdf-viewer/firstmate-pdf-viewer.js) in a real browser.
// pdf.js comes from cdnjs as in production; pdf-lib is served from node_modules.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { chromium } from 'playwright-core';

const require = createRequire(import.meta.url);
const { PDFDocument, PDFName, StandardFonts, rgb, degrees } = require('pdf-lib');
const LIBRARIES = new URL('../../libraries/', import.meta.url);
const PDFJS = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
const PDFLIB = 'https://cdnjs.cloudflare.com/ajax/libs/pdf-lib/1.17.1/pdf-lib.min.js';

async function samplePdf(){
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.HelveticaBold);
  const body = await doc.embedFont(StandardFonts.Helvetica);
  for (let n = 1; n <= 4; n += 1) {
    const page = doc.addPage([612, 792]);
    page.drawRectangle({ x: 0, y: 712, width: 612, height: 80, color: rgb(0.09, 0.64, 0.29) });
    page.drawText(`Page ${n}`, { x: 48, y: 736, size: 32, font, color: rgb(1, 1, 1) });
    page.drawText(`Selectable body text on page ${n}.`, { x: 48, y: 660, size: 14, font: body, color: rgb(0.1, 0.1, 0.1) });
    if (n === 4) page.setRotation(degrees(90));
  }
  return Buffer.from(await doc.save());
}

async function cdnReachable(){
  try { return (await fetch(PDFJS, { method: 'HEAD' })).ok; } catch { return false; }
}

test('pdf viewer renders, navigates, zooms, saves page-keyed markup and downloads with markup', async (t) => {
  if (!await cdnReachable()) { t.skip('cdnjs is not reachable, so pdf.js cannot load'); return; }
  const pdf = await samplePdf();
  const files = {
    '/libraries/pdf-viewer/firstmate-pdf-viewer.js': await readFile(new URL('pdf-viewer/firstmate-pdf-viewer.js', LIBRARIES)),
    '/libraries/markup/firstmate-markup.js': await readFile(new URL('markup/firstmate-markup.js', LIBRARIES))
  };
  const server = createServer((req, res) => {
    const path = new URL(req.url, 'http://fixture').pathname;
    if (path === '/doc.pdf') { res.setHeader('Content-Type', 'application/pdf'); res.end(pdf); return; }
    if (path === '/bad.pdf') { res.setHeader('Content-Type', 'application/pdf'); res.end('%PDF-1.7\nthis is not a pdf at all'); return; }
    if (files[path]) { res.setHeader('Content-Type', 'text/javascript'); res.end(files[path]); return; }
    res.setHeader('Content-Type', 'text/html');
    res.end('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;font-family:Arial}#host{position:fixed;inset:0}</style><div id="host"></div><script src="/libraries/pdf-viewer/firstmate-pdf-viewer.js"></script>');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
  const pdfLib = await readFile(new URL('../node_modules/pdf-lib/dist/pdf-lib.min.js', import.meta.url));
  try {
    const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, acceptDownloads: true });
    await context.route(PDFLIB, (route) => route.fulfill({ body: pdfLib, contentType: 'text/javascript', headers: { 'Access-Control-Allow-Origin': '*' } }));
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(origin);
    await page.evaluate(() => {
      window.events = { pages: [], saves: [], ready: null, errors: [] };
      window.viewer = window.FirstMatePdf.mount(document.querySelector('#host'), {
        url: '/doc.pdf',
        fileName: 'Summary.pdf',
        title: 'Summary',
        markup: {
          enabled: true,
          load: async () => ({ 3: [{ id: 'a1', type: 'arrow', x1: 0.2, y1: 0.4, x2: 0.6, y2: 0.5, color: '#2563eb', size: 2 }] }),
          save: async (pages) => { window.events.saves.push(JSON.parse(JSON.stringify(pages))); }
        },
        onReady: (info) => { window.events.ready = info; },
        onPageChange: (info) => { window.events.pages.push(info.page); },
        onError: (error) => { window.events.errors.push(error.code); }
      });
    });
    await page.evaluate(() => window.viewer.ready);
    assert.deepEqual(await page.evaluate(() => window.events.ready), { pageCount: 4 });
    assert.equal(await page.evaluate(() => window.viewer.pageCount), 4);
    assert.equal(await page.evaluate(() => window.viewer.page), 1);

    // Pages render to canvases and carry a selectable text layer.
    await page.locator('.fm-pdf-page[data-page="1"] canvas.fm-pdf-canvas').waitFor();
    await page.waitForFunction(() => /Page 1/.test(document.querySelector('.fm-pdf-page[data-page="1"] .textLayer')?.textContent || ''));
    const painted = await page.evaluate(() => {
      const canvas = document.querySelector('.fm-pdf-page[data-page="1"] canvas');
      const ctx = canvas.getContext('2d');
      const header = ctx.getImageData(Math.round(canvas.width * 0.95), Math.round(canvas.height * 0.03), 1, 1).data;
      return { width: canvas.width, header: [...header].slice(0, 3) };
    });
    assert.ok(painted.width > 400, 'page 1 is rendered at screen resolution');
    assert.ok(painted.header[1] > 120 && painted.header[0] < 80, `the green header is painted (${painted.header})`);
    // Wide hosts dock the thumbnails rail; the toolbar sits inside the viewer.
    assert.equal(await page.locator('.fm-pdf.rail-open.rail-docked').count(), 1);
    const toolbar = await page.locator('.fm-pdf-toolbar').boundingBox();
    assert.ok(toolbar.y + toolbar.height <= 900 && toolbar.x >= 132, 'toolbar is inside the page area');

    // Page navigation.
    await page.evaluate(() => window.viewer.setPage(3));
    assert.equal(await page.evaluate(() => window.viewer.page), 3);
    assert.deepEqual(await page.evaluate(() => window.events.pages), [3]);
    assert.equal(await page.locator('.fm-pdf-thumb.is-current').getAttribute('data-thumb'), '3');
    const pageTop = await page.evaluate(() => document.querySelector('.fm-pdf-page[data-page="3"]').getBoundingClientRect().top);
    assert.ok(pageTop >= 0 && pageTop < 40, `page 3 is at the top (${pageTop})`);
    await page.evaluate(() => window.viewer.next());
    await page.waitForFunction(() => window.viewer.page === 4);
    await page.locator('.fm-pdf-scroll').focus();
    await page.keyboard.press('Home');
    await page.waitForFunction(() => window.viewer.page === 1);
    // Scrolling tracks the current page.
    await page.evaluate(() => { const sc = document.querySelector('.fm-pdf-scroll'); sc.scrollTop = document.querySelector('.fm-pdf-page[data-page="2"]').offsetTop; });
    await page.waitForFunction(() => window.viewer.page === 2);
    assert.equal(await page.locator('.fm-pdf-pageinput').inputValue(), '2');

    // Zoom: numbers, steps, keyboard and ctrl+wheel; pages are sized from the zoom.
    await page.evaluate(() => window.viewer.setZoom(1));
    assert.equal(await page.evaluate(() => document.querySelector('.fm-pdf-page[data-page="1"]').offsetWidth), 816);
    assert.equal(await page.locator('.fm-pdf-zoomlabel').textContent(), '100%');
    await page.evaluate(() => window.viewer.zoomIn());
    assert.equal(await page.evaluate(() => window.viewer.zoom), 1.1);
    await page.locator('.fm-pdf-scroll').focus();
    await page.keyboard.press('Control+Minus');
    assert.equal(await page.evaluate(() => window.viewer.zoom), 1);
    const box = await page.locator('.fm-pdf-scroll').boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + 200);
    await page.keyboard.down('Control');
    await page.mouse.wheel(0, -240);
    await page.keyboard.up('Control');
    await page.waitForFunction(() => window.viewer.zoom > 1.5);
    await page.waitForTimeout(400);
    const crisp = await page.evaluate(() => {
      const el = document.querySelector('.fm-pdf-page[data-page="2"]');
      return { css: el.offsetWidth, px: el.querySelector('canvas')?.width || 0 };
    });
    assert.ok(crisp.px >= crisp.css, `re-rendered at the new zoom (${crisp.px} px for ${crisp.css} css px)`);
    await page.evaluate(() => window.viewer.setZoom('fit-width'));
    assert.equal(await page.evaluate(() => window.viewer.zoomMode), 'fit-width');

    // Markup: draw on page 2, saved keyed by page number; loaded page 3 markup is kept.
    await page.evaluate(() => window.viewer.setPage(2));
    await page.waitForFunction(() => document.querySelector('.fm-pdf-page[data-page="2"] .fm-photo-markup-layer'));
    await page.evaluate(() => window.viewer.setMarkupActive(true));
    assert.equal(await page.evaluate(() => window.viewer.markupActive), true);
    assert.equal(await page.locator('.fm-pdf-page .r-proposal-markupdock:visible').count(), 0, 'per-page docks are hidden');
    const p2 = await page.locator('.fm-pdf-page[data-page="2"]').boundingBox();
    await page.mouse.move(p2.x + p2.width * 0.2, p2.y + 160);
    await page.mouse.down();
    for (let i = 1; i <= 8; i += 1) await page.mouse.move(p2.x + p2.width * (0.2 + i * 0.05), p2.y + 160 + i * 6);
    await page.mouse.up();
    await page.waitForFunction(() => window.events.saves.length >= 1);
    let saved = await page.evaluate(() => window.events.saves.at(-1));
    assert.deepEqual(Object.keys(saved).sort(), ['2', '3']);
    assert.equal(saved['2'].length, 1);
    assert.equal(saved['2'][0].type, 'stroke');
    assert.ok(saved['2'][0].points.length > 3);
    assert.ok(saved['2'][0].points.every((pt) => pt.x >= 0 && pt.x <= 1 && pt.y >= 0 && pt.y <= 1));
    assert.equal(saved['3'][0].id, 'a1');
    // Undo acts on the page last edited.
    await page.evaluate(() => window.viewer.setPage(4));
    await page.locator('.fm-pdf-mtool[data-act="undo"]').click();
    await page.waitForFunction(() => window.events.saves.at(-1)?.['2']?.length === 0);
    await page.locator('.fm-pdf-mtool[data-act="redo"]').click();
    await page.waitForFunction(() => window.events.saves.at(-1)?.['2']?.length === 1);
    assert.equal(await page.evaluate(() => document.querySelectorAll('.fm-pdf-page[data-page="2"] .fm-photo-markup-path').length), 1);

    // Download: the original bytes, and a copy with the markup drawn into the pages.
    const [plain] = await Promise.all([page.waitForEvent('download'), page.evaluate(() => window.viewer.download({ withMarkup: false }))]);
    assert.equal(plain.suggestedFilename(), 'Summary.pdf');
    assert.ok(Buffer.from(await readFile(await plain.path())).equals(pdf), 'the original file is downloaded unchanged');
    const [marked] = await Promise.all([page.waitForEvent('download'), page.evaluate(() => window.viewer.download({ withMarkup: true }))]);
    assert.equal(marked.suggestedFilename(), 'Summary-markup.pdf');
    const out = await readFile(await marked.path());
    assert.equal(out.subarray(0, 5).toString(), '%PDF-');
    const reloaded = await PDFDocument.load(out);
    assert.equal(reloaded.getPageCount(), 4);
    const xobjects = reloaded.getPages().map((pg) => pg.node.Resources()?.lookup(PDFName.of('XObject'))?.keys().length || 0);
    assert.deepEqual(xobjects, [0, 1, 1, 0], 'pages 2 and 3 each carry one markup image');

    // Destroy flushes a pending save at once.
    const before = await page.evaluate(() => window.events.saves.length);
    await page.evaluate(() => window.viewer.setPage(1));
    const p1 = await page.locator('.fm-pdf-page[data-page="1"]').boundingBox();
    await page.mouse.move(p1.x + 120, p1.y + 300);
    await page.mouse.down();
    await page.mouse.move(p1.x + 220, p1.y + 340);
    await page.mouse.up();
    await page.evaluate(() => window.viewer.destroy());
    const flushed = await page.evaluate(() => window.events.saves.at(-1));
    assert.ok((await page.evaluate(() => window.events.saves.length)) > before);
    assert.equal(flushed['1'].length, 1);
    assert.equal(await page.locator('.fm-pdf').count(), 0);
    assert.deepEqual(errors, []);

    // A file that is not a PDF calls onError and shows a clear error.
    await page.evaluate(() => {
      window.badErrors = [];
      window.bad = window.FirstMatePdf.mount(document.querySelector('#host'), { url: '/bad.pdf', onError: (error) => window.badErrors.push(error.code) });
    });
    await page.waitForFunction(() => window.badErrors.length === 1);
    assert.deepEqual(await page.evaluate(() => window.badErrors), ['invalid']);
    await page.locator('.fm-pdf-error[role="alert"]').waitFor();
    assert.equal(await page.evaluate(() => window.bad.ready.then(() => 'ok', (e) => e.code)), 'invalid');
    await page.evaluate(() => window.bad.destroy());

    // Phones: compact toolbar (page counter only), no thumbnails, fit width.
    const phone = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    await phone.route(PDFLIB, (route) => route.fulfill({ body: pdfLib, contentType: 'text/javascript' }));
    await phone.goto(origin);
    await phone.evaluate(() => { window.viewer = window.FirstMatePdf.mount(document.querySelector('#host'), { url: '/doc.pdf', markup: { enabled: true, save: async () => {} } }); return window.viewer.ready; });
    assert.equal(await phone.locator('.fm-pdf.is-phone').count(), 1);
    assert.equal(await phone.locator('.fm-pdf.rail-open').count(), 0);
    assert.equal(await phone.locator('.fm-pdf-zoomlabel').isVisible(), false);
    assert.equal(await phone.locator('.fm-pdf-pageinput').isVisible(), true);
    const width = await phone.evaluate(() => document.querySelector('.fm-pdf-page').offsetWidth);
    assert.ok(width > 350 && width <= 390, `fit width on a phone (${width})`);
    await phone.close();
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});
