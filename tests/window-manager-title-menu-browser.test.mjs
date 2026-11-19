// The window title opens the window menu on a real mouse click (GP-90): the header's drag gesture captures the
// pointer at pointerdown, so Chrome delivers the click to the header and a target check on the title never matched;
// the docked assistant's "FirstMate Assistant ⌄" did nothing. Runs public/libraries/window-manager/window-manager.js
// in headless Chrome with trusted mouse input.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const { chromium } = createRequire(new URL('../public/v1/package.json', import.meta.url))('playwright-core');
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const SCRIPT = readFileSync(new URL('../public/libraries/window-manager/window-manager.js', import.meta.url));
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<script src="/window-manager.js"></script></head>
<body style="margin:0"><main class="main" style="position:fixed;inset:0"><div id="mainPanels"></div></main></body></html>`;

async function open(t, mode) {
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/window-manager.js')) { res.writeHead(200, { 'content-type': 'text/javascript' }); res.end(SCRIPT); return; }
    res.writeHead(200, { 'content-type': 'text/html' }); res.end(PAGE);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ executablePath: CHROME });
  t.after(async () => { await browser.close(); await new Promise((resolve) => server.close(resolve)); });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 }, reducedMotion: 'reduce' });
  await page.goto(`http://localhost:${server.address().port}/`);
  await page.evaluate((mode) => {
    const host = document.querySelector('main');
    const element = document.createElement('section'), header = document.createElement('header'), title = document.createElement('div');
    title.id = 'title'; title.innerHTML = '<span>FirstMate Assistant</span>'; header.append(title); element.append(header); host.append(element);
    window.win = FirstMateWindows.attach({ element, header, title, host, contentTarget: document.getElementById('mainPanels'), name: 'assistant', label: 'FirstMate Assistant', mode, dockWidth: 440, width: 600, height: 400 });
  }, mode);
  return page;
}

const menus = (page) => page.locator('.fm-window-menu').count();

for (const mode of ['docked', 'floating']) {
  test(`a click on a ${mode} window's title opens its menu, and a second click closes it`, async (t) => {
    const page = await open(t, mode);
    const box = await page.locator('#title span').boundingBox();
    const x = box.x + 20, y = box.y + box.height / 2;
    assert.equal(await page.locator('#title').evaluate((node) => getComputedStyle(node).cursor), 'pointer');
    await page.mouse.click(x, y);
    assert.equal(await menus(page), 1);
    assert.equal(await page.locator('#title').getAttribute('aria-expanded'), 'true');
    await page.mouse.click(x, y);
    assert.equal(await menus(page), 0);
    assert.equal(await page.locator('#title').getAttribute('aria-expanded'), null);
    // The caret right of the text belongs to the title too.
    await page.mouse.click(box.x + box.width + 8, y);
    assert.equal(await menus(page), 1);
    await page.locator('.fm-window-menu [data-dock-placement=left]').click();
    assert.equal(await menus(page), 0);
    assert.deepEqual(await page.evaluate(() => [win.state.mode, win.state.dockSide]), ['docked', 'left']);
  });
}

test('dragging a docked window by its title floats it without opening the menu', async (t) => {
  const page = await open(t, 'docked');
  const box = await page.locator('#title span').boundingBox();
  await page.mouse.move(box.x + 20, box.y + 5);
  await page.mouse.down();
  await page.mouse.move(box.x - 300, box.y + 200, { steps: 8 });
  await page.mouse.up();
  assert.equal(await page.evaluate(() => win.state.mode), 'floating');
  assert.equal(await menus(page), 0);
});
