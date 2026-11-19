// Minimized windows stay clear of open side docks (GP-89): a minimized project window sat on the docked
// assistant tray's "Ask anything" box because the minimized row was placed from the host's right edge.
// Runs public/libraries/window-manager/window-manager.js in headless Chrome.
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

async function open(t, viewport) {
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/window-manager.js')) { res.writeHead(200, { 'content-type': 'text/javascript' }); res.end(SCRIPT); return; }
    res.writeHead(200, { 'content-type': 'text/html' }); res.end(PAGE);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ executablePath: CHROME });
  t.after(async () => { await browser.close(); await new Promise((resolve) => server.close(resolve)); });
  const page = await browser.newPage({ viewport, reducedMotion: 'reduce' });
  await page.goto(`http://localhost:${server.address().port}/`);
  return page;
}

// Opens a tray docked on `side` and `count` minimized windows; returns their boxes.
const LAYOUT = ({ side, count, mobileFullDock }) => {
  const host = document.querySelector('main');
  const make = (name, options) => {
    const element = document.createElement('section'), header = document.createElement('header'), title = document.createElement('span');
    title.textContent = name; header.append(title); element.append(header); host.append(element);
    const win = FirstMateWindows.attach({ element, header, title, host, contentTarget: document.getElementById('mainPanels'), name, label: name, width: 600, height: 400, ...options });
    return { element, win };
  };
  const tray = make('assistant', { mode: 'docked', dockWidth: 440, mobileFullDock });
  if (side !== 'right') tray.win.dock(side);
  const minimized = Array.from({ length: count }, (_, index) => make(`project-${index}`, { mode: 'minimized' }));
  // Read the placed geometry, not a frame of the move transition.
  const rect = (element) => { const left = parseFloat(element.style.left), top = parseFloat(element.style.top); return { left, top, right: left + parseFloat(element.style.width), bottom: top + parseFloat(element.style.height) }; };
  return { width: host.clientWidth, tray: rect(tray.element), minimized: minimized.map(({ element }) => rect(element)) };
};

test('minimized windows sit to the left of a right-docked tray', async (t) => {
  const page = await open(t, { width: 1440, height: 900 });
  const { tray, minimized } = await page.evaluate(LAYOUT, { side: 'right', count: 6 });
  assert.equal(Math.round(tray.right), 1440);
  for (const box of minimized) {
    assert.ok(box.right <= tray.left, `minimized ${JSON.stringify(box)} overlaps the tray at ${tray.left}`);
    assert.ok(box.left >= 0);
  }
  // The first one is next to the tray, as it was next to the page edge before.
  assert.equal(Math.round(minimized[0].right), Math.round(tray.left) - 8);
  // Rows wrap within the space left of the tray.
  assert.ok(new Set(minimized.map((box) => Math.round(box.top))).size > 1);
});

test('minimized windows stay right of a left-docked tray', async (t) => {
  const page = await open(t, { width: 900, height: 700 });
  const { tray, minimized } = await page.evaluate(LAYOUT, { side: 'left', count: 4 });
  assert.equal(Math.round(tray.left), 0);
  for (const box of minimized) assert.ok(box.left >= tray.right, `minimized ${JSON.stringify(box)} overlaps the tray at ${tray.right}`);
});

test('without a dock the minimized row starts at the page edge', async (t) => {
  const page = await open(t, { width: 1200, height: 800 });
  const { minimized } = await page.evaluate(() => {
    const host = document.querySelector('main');
    const element = document.createElement('section'), header = document.createElement('header'), title = document.createElement('span');
    header.append(title); element.append(header); host.append(element);
    FirstMateWindows.attach({ element, header, title, host, name: 'one', label: 'one', mode: 'minimized', width: 600, height: 400 });
    return { minimized: [{ right: parseFloat(element.style.left) + parseFloat(element.style.width) }] };
  });
  assert.equal(Math.round(minimized[0].right), 1200 - 8);
});

test('a phone-width full dock still leaves minimized windows on screen', async (t) => {
  const page = await open(t, { width: 400, height: 800 });
  const { minimized } = await page.evaluate(LAYOUT, { side: 'right', count: 1, mobileFullDock: true });
  assert.ok(minimized[0].left >= 0 && minimized[0].right <= 400 && minimized[0].right - minimized[0].left > 100);
});
