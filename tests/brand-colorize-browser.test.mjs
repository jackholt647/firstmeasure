// GP-77: Forward's merchant portal (Settings › Money › Manage) is recoloured from its one colour to the
// organization's brand colour by an SVG colour matrix on the iframe (public/libraries/brand-colorize). Greys, white
// and black must stay exactly as they are; the base colour and its tints become the brand colour and its tints; in
// family mode a colour on the other side of the wheel (an error red) keeps its colour. Checked on the matrix and on
// real pixels of an iframe in Chromium.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = createRequire(new URL('../public/v1/package.json', import.meta.url))('playwright-core');
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const LIB_PATH = new URL('../public/libraries/brand-colorize/brand-colorize.js', import.meta.url);
const SOURCE = readFileSync(LIB_PATH, 'utf8');
const B = require(LIB_PATH.pathname);

const NEUTRALS = ['#ffffff', '#000000', '#808080', '#fafafa', '#f4f4f4', '#e5e5e5', '#333333'];
const TARGETS = ['#d93025', '#2563eb', '#7c3aed', '#9a7d0d', '#16a34a', '#111827', '#db2777'];
const close = (a, b, tolerance = 1 / 255) => a.every((v, i) => Math.abs(v - b[i]) <= tolerance);

test('the matrix keeps every grey and moves the base, and its tints, onto the brand colour', () => {
  for (const target of TARGETS) {
    const m = B.matrix(B.FORWARD_BASE, target);
    for (const grey of NEUTRALS) assert.equal(B.toHex(B.apply(m, B.parseColor(grey))), grey, `${grey} for ${target}`);
    assert.equal(B.toHex(B.apply(m, B.parseColor(B.FORWARD_BASE))), target);
    // 15% of the base over white -> 15% of the brand colour over white.
    const tint = (rgb) => rgb.map((v) => 0.85 + 0.15 * v);
    assert.ok(close(B.apply(m, tint(B.parseColor(B.FORWARD_BASE))), tint(B.parseColor(target))), target);
  }
  // A grey brand colour turns the portal grey; a grey base has nothing to move.
  assert.equal(B.toHex(B.apply(B.matrix(B.FORWARD_BASE, '#555555'), B.parseColor(B.FORWARD_BASE))), '#555555');
  assert.deepEqual(B.matrix('#777777', '#d93025'), [[1, 0, 0], [0, 1, 0], [0, 0, 1]]);
});

test('readableOnWhite matches the portal rule behind --primary-readable', () => {
  assert.equal(B.readableOnWhite('#d93025'), '#d93025');
  assert.equal(B.readableOnWhite('#facc15'), '#9a7d0d');
});

const CELLS = [
  ['base', B.FORWARD_BASE], ['tint', '#d9ebea'], ['white', '#ffffff'], ['black', '#000000'], ['grey', '#808080'],
  ['light', '#f4f4f5'], ['error', '#d92d20'], ['amber', '#f79009']
];
const FRAME_DOC = `<!doctype html><html><body style="margin:0;display:flex;flex-wrap:wrap">${CELLS.map(([name, color]) => `<div id="${name}" style="width:40px;height:40px;background:${color}"></div>`).join('')}</body></html>`;

async function framePixels(page) {
  const box = await page.locator('iframe').boundingBox();
  const shot = await page.screenshot({ clip: { x: box.x, y: box.y, width: CELLS.length * 40, height: 40 } });
  return page.evaluate(async ({ png, names }) => {
    const image = new Image(); image.src = `data:image/png;base64,${png}`; await image.decode();
    const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
    const g = canvas.getContext('2d'); g.drawImage(image, 0, 0);
    const scale = image.width / (names.length * 40);
    return Object.fromEntries(names.map((name, i) => {
      const [r, gg, b] = g.getImageData(Math.round((i * 40 + 20) * scale), Math.round(20 * scale), 1, 1).data;
      return [name, '#' + [r, gg, b].map((v) => v.toString(16).padStart(2, '0')).join('')];
    }));
  }, { png: shot.toString('base64'), names: CELLS.map(([name]) => name) });
}
const near = (hex, expected, tolerance = 3) => {
  const a = B.parseColor(hex), b = B.parseColor(expected);
  return a.every((v, i) => Math.abs(v - b[i]) * 255 <= tolerance);
};

test('an attached iframe is drawn in the brand colour, greys untouched; family mode keeps opposite colours', async () => {
  const browser = await chromium.launch({ executablePath: CHROME });
  try {
    const page = await browser.newPage({ viewport: { width: 600, height: 200 }, deviceScaleFactor: 1 });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.setContent(`<!doctype html><html><head><style>:root{--primary:#2563eb;--primary-readable:#2563eb}</style></head><body style="margin:0"><iframe style="display:block;border:0;width:${CELLS.length * 40}px;height:40px"></iframe></body></html>`);
    await page.addScriptTag({ content: SOURCE });
    await page.evaluate((html) => { document.querySelector('iframe').srcdoc = html; }, FRAME_DOC);
    await page.waitForFunction(() => document.querySelector('iframe').contentDocument?.getElementById('amber'));

    const before = await framePixels(page);
    assert.ok(near(before.base, B.FORWARD_BASE), JSON.stringify(before));

    await page.evaluate(() => window.FirstMateBrandColorize.attach(document.querySelector('iframe')));
    assert.match(await page.evaluate(() => document.querySelector('iframe').style.filter), /^url\("?#fm-brand-colorize-007a76-2563eb-family"?\)$/);
    let px = await framePixels(page);
    assert.ok(near(px.base, '#2563eb'), `base ${px.base}`);
    for (const name of ['white', 'black', 'grey', 'light']) assert.ok(near(px[name], before[name], 1), `${name} ${px[name]} was ${before[name]}`);
    const expectedTint = B.toHex(B.apply(B.matrix(B.FORWARD_BASE, '#2563eb'), B.parseColor('#d9ebea')));
    assert.ok(near(px.tint, expectedTint), `tint ${px.tint} expected ${expectedTint}`);
    assert.ok(near(px.error, '#d92d20'), `error red kept: ${px.error}`);
    assert.ok(near(px.amber, '#f79009'), `amber kept: ${px.amber}`);

    // The dev console's preview repaints every attached frame, in either mode, and clearing it goes back.
    await page.evaluate(() => window.FirstMateBrandColorize.preview('#d93025', { mode: 'all' }));
    px = await framePixels(page);
    assert.ok(near(px.base, '#d93025'), `preview base ${px.base}`);
    assert.ok(near(px.white, '#ffffff', 1) && near(px.grey, '#808080', 1));
    assert.ok(!near(px.error, '#d92d20', 20), `all mode turns the opposite red too: ${px.error}`);
    await page.evaluate(() => window.FirstMateBrandColorize.preview(null));
    px = await framePixels(page);
    assert.ok(near(px.base, '#2563eb'), `back to the brand colour ${px.base}`);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});
