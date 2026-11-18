// FM-598: the Communications setup's channel cards (comms-setup.js) show one tooltip at a time. A clicked card keeps
// focus, so a tip shows on hover or keyboard focus (:focus-visible) only, and while the pointer is on a card no other
// card's tip shows. Runs the library's own stylesheet in Chromium over the cards' markup.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const { chromium } = createRequire(new URL('../public/v1/package.json', import.meta.url))('playwright-core');
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const SOURCE = readFileSync(new URL('../public/libraries/guided-experiences/comms-setup.js', import.meta.url), 'utf8');
const CSS = SOURCE.match(/const css = `([\s\S]*?)`;/)[1];

const card = (id) => `<button type="button" class="gxc-way" data-gxc-way="${id}" aria-describedby="gxc-tip-${id}"><span class="gxc-way-name"><strong>${id}</strong></span><span class="gxc-tip" role="tooltip" id="gxc-tip-${id}">About ${id}</span></button>`;
const PAGE = `<!doctype html><html><head><style>*,*::before,*::after{transition:none!important;animation:none!important}${CSS}</style></head>
  <body style="margin:0;font-family:Arial"><div class="gxc" style="width:900px;padding:160px 20px 20px"><div class="gxc-ways">${['texts', 'calls', 'email'].map(card).join('')}</div></div></body></html>`;

const shown = (page) => page.evaluate(() => [...document.querySelectorAll('.gxc-tip')].filter((tip) => Number(getComputedStyle(tip).opacity) > 0.5).map((tip) => tip.id.replace('gxc-tip-', '')));

test('a clicked card does not keep its tooltip while another card is hovered', async () => {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1000, height: 500 } });
    await page.setContent(PAGE);
    assert.deepEqual(await shown(page), []);
    await page.locator('[data-gxc-way=texts]').click();
    assert.deepEqual(await shown(page), ['texts']);
    await page.locator('[data-gxc-way=calls]').hover();
    assert.deepEqual(await shown(page), ['calls']);
    await page.mouse.move(2, 2);
    assert.deepEqual(await shown(page), [], 'the clicked card is still focused, but its tip goes with the pointer');
  } finally {
    await browser.close();
  }
});

test('keyboard focus shows its tooltip until the pointer is on another card', async () => {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1000, height: 500 } });
    await page.setContent(PAGE);
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement.dataset.gxcWay), 'calls');
    assert.deepEqual(await shown(page), ['calls']);
    await page.locator('[data-gxc-way=email]').hover();
    assert.deepEqual(await shown(page), ['email']);
    await page.locator('[data-gxc-way=calls]').hover();
    assert.deepEqual(await shown(page), ['calls']);
    await page.mouse.move(2, 2);
    assert.deepEqual(await shown(page), ['calls']);
  } finally {
    await browser.close();
  }
});
