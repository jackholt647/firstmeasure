// GP-56: a picked choice tile (.gxs-choice, GP-46) shows its check mark in the middle of its round tick. A setup's own
// rule for the spans in its tiles (`.gxw-choice span{display:flex}`) also caught the tick, which lost its centring and
// drew the check in the circle's top-left corner. Runs each setup's own stylesheet, with the shared choice layout, in
// Chromium over the tile's markup, and checks the check mark is centred in the circle.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const { chromium } = createRequire(new URL('../public/v1/package.json', import.meta.url))('playwright-core');
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const read = (file) => readFileSync(new URL(`../public/libraries/guided-experiences/${file}`, import.meta.url), 'utf8');
const SHARED = read('guided-setup.js').match(/\/\* GP-46:[\s\S]*?\*\/([\s\S]*?)`/)[1];

const SETUPS = [
  { file: 'workforce-setup.js', tile: 'gxw-choice', icon: 'gxw-icon', tick: 'gxw-tick', on: 'aria-pressed' },
  { file: 'documents-setup.js', tile: 'gxd-tile', icon: 'gxd-icon', tick: 'gxd-tick', on: 'aria-checked' },
];

for (const setup of SETUPS) {
  test(`${setup.file}: a picked tile's check mark is centred in its tick`, async () => {
    const source = read(setup.file);
    const css = source.match(/const css = `([\s\S]*?)`;/)[1];
    const tick = source.match(/const choiceTick = '([^']+)';/)[1];
    assert.ok(tick.includes(setup.tick), `${setup.file} draws its tick with .${setup.tick}`);
    const tile = (on) => `<button type="button" class="${setup.tile} gxs-choice" ${setup.on}="${on}"><span class="${setup.icon} gxs-choice-icon"><i></i></span><span class="gxs-choice-text"><strong>Crews and subcontractors</strong><small>Some work is ours, some goes to outside companies.</small></span>${tick}</button>`;
    const page = `<!doctype html><html><head><style>*,*::before,*::after{transition:none!important}${SHARED}${css}</style></head>
      <body style="margin:0;font-family:Arial"><div class="gxs-choices" style="--gxs-n:2">${tile(false)}${tile(true)}</div></body></html>`;
    const browser = await chromium.launch({ executablePath: CHROME, headless: true });
    try {
      for (const width of [1200, 400]) {
        const tab = await browser.newPage({ viewport: { width, height: 900 } });
        await tab.setContent(page);
        const ticks = await tab.evaluate((on) => [...document.querySelectorAll('.gxs-choice-tick')].map((el) => {
          const box = el.getBoundingClientRect(), svg = el.querySelector('svg').getBoundingClientRect();
          return { picked: el.parentElement.getAttribute(on) === 'true', opacity: Number(getComputedStyle(el.querySelector('svg')).opacity), dx: (svg.left + svg.width / 2) - (box.left + box.width / 2), dy: (svg.top + svg.height / 2) - (box.top + box.height / 2), svg: svg.width };
        }), setup.on);
        assert.equal(ticks.length, 2);
        for (const mark of ticks) {
          assert.ok(Math.abs(mark.dx) < 1 && Math.abs(mark.dy) < 1, `${setup.file} at ${width}px: check mark is ${mark.dx.toFixed(1)}, ${mark.dy.toFixed(1)} px off the tick's centre`);
          assert.ok(mark.svg >= 10, `${setup.file} at ${width}px: check mark is ${mark.svg}px wide`);
        }
        assert.deepEqual(ticks.map((mark) => mark.opacity), [0, 1], 'only the picked tile shows its check mark');
        await tab.close();
      }
    } finally {
      await browser.close();
    }
  });
}
