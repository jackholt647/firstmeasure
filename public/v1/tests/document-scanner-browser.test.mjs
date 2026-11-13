import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';

// FM-432: the document scanner (public/libraries/document-scanner) over the platform camera. A photo of a sheet on a
// table is found, straightened and saved as one PDF with a page per photo; a picture with no page in it keeps the
// whole photo and says so; a failed save keeps the pages; Discard saves nothing.

const libraries = new URL('../../libraries/', import.meta.url);
const PHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };
const launch = () => chromium.launch({
  executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: true,
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream']
});

async function pageFor(browser){
  const context = await browser.newContext(PHONE);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('https://scan.test/**', async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname.startsWith('/libraries/')) return route.fulfill({ contentType: 'application/javascript; charset=utf-8', body: await readFile(new URL(pathname.slice('/libraries/'.length), libraries)) });
    return route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><body style="margin:0"></body>' });
  });
  await page.goto('https://scan.test/');
  await page.addScriptTag({ url: '/libraries/camera-capture/camera-capture.js' });
  await page.addScriptTag({ url: '/libraries/document-scanner/document-scanner.js' });
  return { page, errors, context };
}

// A photo of a sheet with lines of text, lying at an angle on a wooden table: corners in pixels.
const SHEET = [{ x: 260, y: 170 }, { x: 900, y: 230 }, { x: 860, y: 1120 }, { x: 180, y: 1060 }];
function photo(page, { corners = SHEET, table = '#6b4f3a', sheet = '#f4f1ea', shadow = 0.28, width = 1080, height = 1440, type = 'image/jpeg' } = {}){
  return page.evaluate(({ corners, table, sheet, shadow, width, height, type }) => {
    const canvas = document.createElement('canvas');
    canvas.width = width; canvas.height = height;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = table; ctx.fillRect(0, 0, width, height);
    // Grain, so the table is not one flat colour.
    for (let i = 0; i < 4000; i += 1) { ctx.fillStyle = `rgba(0,0,0,${(i % 7) / 40})`; ctx.fillRect((i * 97) % width, (i * 53) % height, 6, 2); }
    if (corners) {
      ctx.fillStyle = sheet;
      ctx.beginPath(); corners.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y))); ctx.closePath(); ctx.fill();
      // A shadow across the lower half of the sheet.
      const shade = ctx.createLinearGradient(0, height * 0.4, 0, height);
      shade.addColorStop(0, 'rgba(0,0,0,0)'); shade.addColorStop(1, `rgba(0,0,0,${shadow})`);
      ctx.save(); ctx.clip(); ctx.fillStyle = shade; ctx.fillRect(0, 0, width, height); ctx.restore();
      ctx.fillStyle = '#1d2939';
      for (let line = 0; line < 14; line += 1) {
        const t = 0.12 + line * 0.055;
        const a = { x: corners[0].x + (corners[3].x - corners[0].x) * t, y: corners[0].y + (corners[3].y - corners[0].y) * t };
        const b = { x: corners[1].x + (corners[2].x - corners[1].x) * t, y: corners[1].y + (corners[2].y - corners[1].y) * t };
        ctx.beginPath(); ctx.moveTo(a.x + (b.x - a.x) * 0.1, a.y + (b.y - a.y) * 0.1); ctx.lineTo(a.x + (b.x - a.x) * (line % 3 ? 0.85 : 0.55), a.y + (b.y - a.y) * (line % 3 ? 0.85 : 0.55));
        ctx.lineWidth = 9; ctx.strokeStyle = '#1d2939'; ctx.stroke();
      }
    }
    return canvas.toDataURL(type, 0.92).split(',')[1];
  }, { corners, table, sheet, shadow, width, height, type });
}
const file = (name, base64, mimeType = 'image/jpeg') => ({ name, mimeType, buffer: Buffer.from(base64, 'base64') });

/** detectPage on an image (base64) in the page: { found, quad in pixels }. */
const detect = (page, base64, width, height) => page.evaluate(async ({ base64, width, height }) => {
  const img = new Image();
  img.src = 'data:image/jpeg;base64,' + base64;
  await img.decode();
  const canvas = document.createElement('canvas');
  const scale = 256 / Math.max(width, height);
  canvas.width = Math.round(width * scale); canvas.height = Math.round(height * scale);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const result = window.FirstMateDocumentScanner._internals.detectPage(data.data, data.width, data.height);
  return { found: result.found, quad: result.quad.map((p) => ({ x: p.x * width, y: p.y * height })) };
}, { base64, width, height });

/** Pages of a PDF: its declared count, and each image's size, read from the bytes. */
function readPdf(bytes){
  const text = Buffer.from(bytes).toString('latin1');
  const xref = Number(text.match(/startxref\n(\d+)\n%%EOF\n$/)[1]);
  assert.ok(text.slice(xref).startsWith('xref\n'), 'startxref points at the table');
  const rows = text.slice(xref).split('\n').slice(3).filter((row) => / 00000 n $/.test(row));
  rows.forEach((row, i) => assert.ok(text.slice(Number(row.slice(0, 10))).startsWith(`${i + 1} 0 obj`), `object ${i + 1} is where the table says`));
  return {
    header: text.slice(0, 8),
    count: Number(text.match(/\/Type \/Pages \/Kids \[[^\]]*\] \/Count (\d+)/)[1]),
    images: [...text.matchAll(/\/Subtype \/Image \/Width (\d+) \/Height (\d+)/g)].map((m) => ({ width: Number(m[1]), height: Number(m[2]) })),
    boxes: [...text.matchAll(/\/MediaBox \[0 0 ([\d.]+) ([\d.]+)\]/g)].map((m) => ({ width: Number(m[1]), height: Number(m[2]) }))
  };
}

test('a sheet on a table is found to within a few pixels; a picture with no page is not', async () => {
  const browser = await launch();
  try {
    const { page, errors } = await pageFor(browser);
    const found = await detect(page, await photo(page), 1080, 1440);
    assert.equal(found.found, true);
    found.quad.forEach((p, i) => assert.ok(Math.hypot(p.x - SHEET[i].x, p.y - SHEET[i].y) < 1440 * 0.025, `corner ${i}: ${JSON.stringify(p)} vs ${JSON.stringify(SHEET[i])}`));
    const empty = await detect(page, await photo(page, { corners: null }), 1080, 1440);
    assert.equal(empty.found, false, 'just the table');
    assert.deepEqual(empty.quad.map((p) => [Math.round(p.x), Math.round(p.y)]), [[0, 0], [1080, 0], [1080, 1440], [0, 1440]], 'the whole photo');
    for (const [label, options] of [['a deep shadow over the paper', { shadow: 0.5 }], ['a grey desk', { table: '#a0a4aa' }]]) {
      const result = await detect(page, await photo(page, options), 1080, 1440);
      assert.equal(result.found, true, label);
      result.quad.forEach((p, i) => assert.ok(Math.hypot(p.x - SHEET[i].x, p.y - SHEET[i].y) < 1440 * 0.025, `${label}, corner ${i}: ${JSON.stringify(p)}`));
    }
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('the PDF writer makes one page per image, sized 8.5 in across, with a valid cross-reference table', async () => {
  const browser = await launch();
  try {
    const { page } = await pageFor(browser);
    const bytes = await page.evaluate(async () => {
      const page = async (w, h) => {
        const canvas = document.createElement('canvas'); canvas.width = w; canvas.height = h;
        canvas.getContext('2d').fillRect(0, 0, w / 2, h / 2);
        const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.8));
        return { bytes: new Uint8Array(await blob.arrayBuffer()), width: w, height: h };
      };
      return [...window.FirstMateDocumentScanner._internals.buildPdf([await page(850, 1100), await page(1100, 850)])];
    });
    const pdf = readPdf(bytes);
    assert.equal(pdf.header, '%PDF-1.4');
    assert.equal(pdf.count, 2);
    assert.deepEqual(pdf.images, [{ width: 850, height: 1100 }, { width: 1100, height: 850 }]);
    assert.deepEqual(pdf.boxes, [{ width: 612, height: 792 }, { width: 792, height: 612 }]);
  } finally { await browser.close(); }
});

/** Open the scanner; `save` is recorded on window.saves and fails while window.failSaves > 0. */
async function openScanner(page){
  await page.evaluate(() => {
    window.saves = []; window.failSaves = 0; window.scanDone = null;
    window.scanResult = window.FirstMateDocumentScanner.open({
      subtitle: '2205 Mimosa Pl',
      save: async (file, meta) => {
        if (window.failSaves > 0) { window.failSaves -= 1; throw new Error('The network is down.'); }
        window.saves.push({ name: file.name, type: file.type, meta, bytes: [...new Uint8Array(await file.arrayBuffer())] });
        return 'saved-record';
      }
    }).then((value) => { window.scanDone = { value }; return value; });
  });
  await page.waitForSelector('.fmc-shell.fullscreen.open');
}

test('photos become a reviewed, straightened PDF; a failed save keeps the pages; rotate, reorder and the look apply', async () => {
  const browser = await launch();
  try {
    const { page, errors } = await pageFor(browser);
    await openScanner(page);
    assert.match(await page.locator('.fmc-head-title').innerText(), /Scan paper\s+2205 Mimosa Pl/);
    // The live outline runs over the camera (the fake camera shows no page, so it only says what to do).
    await page.waitForFunction(() => document.querySelector('.fmds-hint')?.textContent, null, { timeout: 5000 }).catch(() => null);
    const sheet = await photo(page);
    const skewed = await photo(page, { corners: [{ x: 120, y: 260 }, { x: 980, y: 300 }, { x: 1000, y: 900 }, { x: 90, y: 940 }] });
    const nothing = await photo(page, { corners: null });
    await page.locator('[data-fmc-input]').setInputFiles([file('a.jpg', sheet), file('b.jpg', skewed), file('c.jpg', nothing)]);
    await page.waitForFunction(() => document.querySelectorAll('.fmc-strip .fmc-tile').length === 3);
    await page.locator('[data-fmc-done]').tap();
    await page.waitForFunction(() => document.querySelectorAll('.fmds-page').length === 3 && !document.querySelector('.fmds-page.busy'), null, { timeout: 15000 });
    assert.equal(await page.locator('.fmc-step-head strong').innerText(), 'Review scan');
    await page.waitForSelector('.fmds-page:nth-child(3) .fmds-loose');
    assert.equal(await page.locator('.fmds-loose').count(), 1, 'only the photo with no page is flagged');
    assert.equal(await page.locator('[data-fmds-save]').innerText(), 'Save 3 pages');

    // The third page: remove it.
    await page.locator('.fmds-page').nth(2).tap();
    await page.waitForSelector('.fmds-crop-box canvas');
    assert.equal(await page.locator('.fmc-step-head strong').innerText(), 'Page 3');
    await page.locator('[data-fmds-remove]').tap();
    await page.waitForFunction(() => document.querySelectorAll('.fmds-page').length === 2);
    assert.equal(await page.locator('.fmc-strip .fmc-tile').count(), 2, 'a removed page leaves the camera strip too');

    // The second page: drag a corner, rotate it, and make it the first.
    await page.locator('.fmds-page').nth(1).tap();
    await page.waitForSelector('.fmds-crop-box canvas');
    const handle = await page.locator('[data-fmds-corner="0"]').boundingBox();
    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
    await page.mouse.down();
    await page.mouse.move(handle.x + handle.width / 2 + 12, handle.y + handle.height / 2 + 12, { steps: 4 });
    await page.mouse.up();
    await page.locator('[data-fmds-rotate]').tap();
    assert.equal(await page.locator('[data-fmds-rotate]').innerText(), 'Rotate · 90°');
    await page.locator('[data-fmds-earlier]').tap();
    assert.equal(await page.locator('.fmc-step-head strong').innerText(), 'Page 1');
    await page.locator('[data-fmds-done]').tap();
    await page.waitForFunction(() => document.querySelectorAll('.fmds-page img[src^="data:"]').length === 2);

    await page.locator('[data-fmds-filter="bw"]').tap();
    assert.equal(await page.locator('[data-fmds-filter="bw"]').getAttribute('aria-checked'), 'true');
    await page.locator('[data-fmds-name]').fill('Signed contract');

    // The first save fails: the error shows and the pages stay.
    await page.evaluate(() => { window.failSaves = 1; });
    await page.locator('[data-fmds-save]').tap();
    await page.waitForFunction(() => document.querySelector('[data-fmds-error]')?.textContent);
    assert.equal(await page.locator('[data-fmds-error]').innerText(), 'The network is down.');
    assert.equal(await page.locator('.fmds-page').count(), 2);
    assert.equal(await page.locator('[data-fmds-save]').isEnabled(), true);

    await page.locator('[data-fmds-save]').tap();
    await page.waitForFunction(() => window.scanDone, null, { timeout: 20000 });
    assert.deepEqual(await page.evaluate(() => window.scanDone), { value: 'saved-record' });
    await page.waitForFunction(() => !document.querySelector('.fmc-shell'));
    const [saved] = await page.evaluate(() => window.saves);
    assert.equal(saved.name, 'Signed contract.pdf');
    assert.equal(saved.type, 'application/pdf');
    assert.deepEqual(saved.meta, { pages: 2, name: 'Signed contract' });
    const pdf = readPdf(saved.bytes);
    assert.equal(pdf.count, 2);
    // Page 1 is the skewed sheet turned a quarter: wider than tall before, taller than wide now.
    assert.ok(pdf.images[0].height > pdf.images[0].width, `rotated page ${JSON.stringify(pdf.images[0])}`);
    // Page 2 is the first sheet, straightened to its own proportions (about 640 × 890 in the photo).
    const ratio = pdf.images[1].height / pdf.images[1].width;
    assert.ok(ratio > 1.3 && ratio < 1.5, `straightened sheet ratio ${ratio}`);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('Discard and closing the camera with no photos save nothing', async () => {
  const browser = await launch();
  try {
    const { page, errors } = await pageFor(browser);
    await openScanner(page);
    await page.locator('[data-fmc-back]').tap();
    await page.waitForFunction(() => window.scanDone);
    assert.deepEqual(await page.evaluate(() => window.scanDone), { value: null });

    await openScanner(page);
    await page.locator('[data-fmc-input]').setInputFiles([file('a.jpg', await photo(page))]);
    await page.waitForFunction(() => document.querySelectorAll('.fmc-strip .fmc-tile').length === 1);
    await page.locator('[data-fmc-done]').tap();
    await page.waitForSelector('[data-fmds-discard]');
    page.once('dialog', (dialog) => dialog.accept());
    await page.locator('[data-fmds-discard]').tap();
    await page.waitForFunction(() => window.scanDone);
    assert.deepEqual(await page.evaluate(() => window.scanDone), { value: null });
    assert.deepEqual(await page.evaluate(() => window.saves), []);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
