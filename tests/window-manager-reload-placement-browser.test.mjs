// A refresh keeps each window where it was (GP-148): a minimized project came back maximized because nothing kept a
// window's mode, dock or position across a reload. Windows that name a restoreKey are saved per browser tab on
// pagehide and put back when the app reopens them after a reload, and only after a reload.
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

async function open(t) {
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/window-manager.js')) { res.writeHead(200, { 'content-type': 'text/javascript' }); res.end(SCRIPT); return; }
    res.writeHead(200, { 'content-type': 'text/html' }); res.end(req.url.startsWith('/frame') ? PAGE : PAGE.replace('</main>', '</main><iframe src="/frame" style="display:none"></iframe>'));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ executablePath: CHROME });
  t.after(async () => { await browser.close(); await new Promise((resolve) => server.close(resolve)); });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 }, reducedMotion: 'reduce' });
  await page.goto(`http://localhost:${server.address().port}/`);
  return page;
}

// Opens (or reopens) the named windows and returns their state and box.
const OPEN = (names) => {
  const host = document.querySelector('main');
  window.wins = {};
  return Object.fromEntries(names.map((name) => {
    const element = document.createElement('section'), header = document.createElement('header'), title = document.createElement('span');
    title.textContent = name; header.append(title); element.append(header); host.append(element);
    const win = FirstMateWindows.attach({ element, header, title, host, contentTarget: document.getElementById('mainPanels'), name, label: name, mode: 'modal', presentationModes: true, width: 600, height: 400, restoreKey: () => 'project:' + name });
    window.wins[name] = win;
    return [name, { ...win.state, placement: win.placement }];
  }));
};

test('a reload puts minimized, docked and moved windows back where they were', async (t) => {
  const page = await open(t);
  await page.evaluate(OPEN, ['a', 'b', 'c', 'd']);
  await page.evaluate(() => {
    wins.a.setMode('docked'); wins.a.setMode('minimized');
    wins.b.dock('left');
    wins.c.setMode('floating');
    wins.d.setVisible(false);
  });
  const before = await page.evaluate(() => Object.fromEntries(Object.entries(wins).map(([name, win]) => [name, win.placement])));
  await page.reload();
  // Only the windows the app reopens take a placement; the rest wait for theirs.
  assert.deepEqual((await page.evaluate(() => FirstMateWindows.reloadPlacements('project:'))).map((item) => item.key), ['project:a', 'project:b', 'project:c']);
  const after = await page.evaluate(OPEN, ['a', 'b', 'c', 'd']);
  assert.equal(after.a.mode, 'minimized');
  assert.equal(after.a.restored, true);
  assert.equal(after.a.placement.previous, 'docked', 'Restore goes back to the dock, not the opening mode');
  assert.equal(after.b.mode, 'docked');
  assert.equal(after.b.dockSide, 'left');
  assert.equal(after.c.mode, 'floating');
  assert.deepEqual(after.c.placement.rect, before.c.rect);
  // A closed window is not remembered and opens as usual.
  assert.equal(after.d.mode, 'modal');
  assert.equal(after.d.restored, false);
  assert.deepEqual(await page.evaluate(() => FirstMateWindows.reloadPlacements('project:')), []);
  await page.evaluate(() => wins.a.restore());
  assert.equal(await page.evaluate(() => wins.a.state.mode), 'docked');
});

test('only a reload restores, and a frame on the page never overwrites the top page', async (t) => {
  const page = await open(t);
  await page.evaluate(OPEN, ['a']);
  await page.evaluate(() => wins.a.setMode('minimized'));
  // A new visit to the page (not a reload) opens windows as usual.
  await page.goto(page.url());
  assert.deepEqual(await page.evaluate(() => FirstMateWindows.reloadPlacements()), []);
  assert.equal((await page.evaluate(OPEN, ['a'])).a.mode, 'modal');
  await page.evaluate(() => wins.a.setMode('minimized'));
  await page.reload();
  assert.equal((await page.evaluate(OPEN, ['a'])).a.mode, 'minimized');
  // The saved state is used once.
  await page.evaluate(() => wins.a.setMode('floating'));
  await page.reload();
  assert.equal((await page.evaluate(OPEN, ['a'])).a.mode, 'floating');
});
