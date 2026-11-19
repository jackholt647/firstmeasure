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
  ['light', '#f4f4f5'], ['zinc', '#71717a'], ['zinc7', '#3f3f46'], ['brand50', '#f0fafa'], ['error', '#d92d20'], ['amber', '#f79009']
];
// Grey text under the cells: Forward's frame is another origin, drawn in its own process with subpixel (LCD) text,
// whose cyan and red fringes must not turn grey text brown.
const TEXT = 'Applications Accounts Payments Disputes';
const FRAME_DOC = `<!doctype html><html><body style="margin:0;background:#fff"><div style="display:flex">${CELLS.map(([name, color]) => `<div id="${name}" style="width:40px;height:40px;background:${color}"></div>`).join('')}</div>`
  + `<div style="height:40px;padding:10px 6px;box-sizing:border-box;font:500 15px Arial,sans-serif;color:rgb(23,23,23)">${TEXT}</div>`
  + `<div style="height:40px;padding:10px 6px;box-sizing:border-box;font:500 15px Arial,sans-serif;color:rgb(113,113,122)">${TEXT}</div></body></html>`;

async function framePixels(page) {
  const box = await page.locator('iframe').boundingBox();
  const shot = await page.screenshot({ clip: { x: box.x, y: box.y, width: CELLS.length * 40, height: 120 } });
  return page.evaluate(async ({ png, names }) => {
    const image = new Image(); image.src = `data:image/png;base64,${png}`; await image.decode();
    const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
    const g = canvas.getContext('2d'); g.drawImage(image, 0, 0);
    const scale = image.width / (names.length * 40);
    const cells = Object.fromEntries(names.map((name, i) => {
      const [r, gg, b] = g.getImageData(Math.round((i * 40 + 20) * scale), Math.round(20 * scale), 1, 1).data;
      return [name, '#' + [r, gg, b].map((v) => v.toString(16).padStart(2, '0')).join('')];
    }));
    // Mean colour of each text row's inked pixels, and how many of them are visibly coloured.
    const row = (top) => {
      const d = g.getImageData(0, Math.round(top * scale), image.width, Math.round(40 * scale)).data;
      const sum = [0, 0, 0]; let n = 0;
      for (let i = 0; i < d.length; i += 4) {
        if (d[i] + d[i + 1] + d[i + 2] > 750) continue;
        n += 1; sum[0] += d[i]; sum[1] += d[i + 1]; sum[2] += d[i + 2];
      }
      return { n, mean: sum.map((v) => Math.round(v / Math.max(1, n))) };
    };
    return { ...cells, text: row(40), zincText: row(80) };
  }, { png: shot.toString('base64'), names: CELLS.map(([name]) => name) });
}
const near = (hex, expected, tolerance = 3) => {
  const a = B.parseColor(hex), b = B.parseColor(expected);
  return a.every((v, i) => Math.abs(v - b[i]) * 255 <= tolerance);
};
const sameMean = (a, b, tolerance = 2) => a.n > 100 && a.mean.every((v, i) => Math.abs(v - b.mean[i]) <= tolerance);

test('an attached iframe is drawn in the brand colour, greys untouched; family mode keeps opposite colours', async () => {
  const browser = await chromium.launch({ executablePath: CHROME });
  try {
    const page = await browser.newPage({ viewport: { width: 600, height: 200 }, deviceScaleFactor: 1 });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('https://portal.test/**', (route) => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><head><style>:root{--primary:#2563eb;--primary-readable:#2563eb}</style></head><body style="margin:0"><iframe src="https://forward.test/" style="display:block;border:0;width:${CELLS.length * 40}px;height:120px"></iframe></body></html>` }));
    await page.route('https://forward.test/**', (route) => route.fulfill({ contentType: 'text/html', body: FRAME_DOC }));
    await page.goto('https://portal.test/');
    await page.addScriptTag({ content: SOURCE });
    await page.waitForFunction(() => document.querySelector('iframe') && performance.now() > 0);
    await page.frameLocator('iframe').locator('#amber').waitFor();

    const before = await framePixels(page);
    assert.ok(near(before.base, B.FORWARD_BASE), JSON.stringify(before));

    await page.evaluate(() => window.FirstMateBrandColorize.attach(document.querySelector('iframe')));
    assert.match(await page.evaluate(() => document.querySelector('iframe').style.filter), /^url\("?#fm-brand-colorize-007a76-2563eb-family"?\)$/);
    let px = await framePixels(page);
    assert.ok(near(px.base, '#2563eb'), `base ${px.base}`);
    // Forward's text greys are Tailwind zinc, faintly blue: still greys, so they stay.
    for (const name of ['white', 'black', 'grey', 'light', 'zinc', 'zinc7']) assert.ok(near(px[name], before[name], 1), `${name} ${px[name]} was ${before[name]}`);
    assert.ok(sameMean(px.text, before.text), `grey text ${JSON.stringify(px.text)} was ${JSON.stringify(before.text)}`);
    assert.ok(sameMean(px.zincText, before.zincText), `zinc text ${JSON.stringify(px.zincText)} was ${JSON.stringify(before.zincText)}`);
    const expectedTint = B.toHex(B.apply(B.matrix(B.FORWARD_BASE, '#2563eb'), B.parseColor('#d9ebea')));
    assert.ok(near(px.tint, expectedTint), `tint ${px.tint} expected ${expectedTint}`);
    const expected50 = B.toHex(B.apply(B.matrix(B.FORWARD_BASE, '#2563eb'), B.parseColor('#f0fafa')));
    assert.ok(near(px.brand50, expected50), `Forward's lightest tint ${px.brand50} expected ${expected50}`);
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
