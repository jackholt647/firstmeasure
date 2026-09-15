const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require('../public/v1/node_modules/playwright-core');

test('roof editor swaps live view nodes and resizes all three panes', async () => {
  const systemBrowser = process.platform === 'win32' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : '/usr/bin/chromium';
  const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || (fs.existsSync(systemBrowser) ? systemBrowser : chromium.executablePath()), args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
    await page.route('http://pane.test/', route => route.fulfill({ contentType: 'text/html', body: '<style>body{margin:0}#workspace{display:flex;width:1200px;height:800px}#leftColumn{width:60%}#rightColumn{display:flex;flex:1;min-width:0;flex-direction:column}#dragResizer{width:8px}#verticalResizer{height:8px}#three-view-wrapper,#google-earth-wrapper{flex:1}</style><div id="workspace"><div id="leftColumn"><canvas id="roof"></canvas></div><div id="dragResizer"></div><div id="rightColumn"><div id="three-view-wrapper"><canvas id="three"></canvas></div><div id="verticalResizer"></div><div id="google-earth-wrapper"><iframe id="map"></iframe></div></div></div>' }));
    await page.goto('http://pane.test/');
    await page.addScriptTag({ path: 'public/measure/internal/editor_scripts/pane_layout.js' });
    const editor = fs.readFileSync('public/measure/internal/editor.php', 'utf8').replace(/\r\n/g, '\n');
    const start = editor.indexOf('        // Resizer Logic\n');
    assert.ok(start > 0);
    const end = editor.indexOf("        if (typeof window.loadProjectFromFolder === 'function')", start);
    await page.addScriptTag({ content: editor.slice(start, end) });
    await page.evaluate(() => { window.originalRoof = document.getElementById('roof'); window.originalThree = document.getElementById('three'); });
    await page.getByRole('button', { name: 'Swap 2D and 3D views', exact: true }).click();
    assert.equal(await page.locator('#main-pane-slot > div').getAttribute('id'), 'three-view-wrapper');
    assert.equal(await page.evaluate(() => window.originalRoof === document.getElementById('roof') && window.originalThree === document.getElementById('three')), true);
    const before = await page.locator('#main-pane-slot').boundingBox();
    const upperBefore = await page.locator('#upper-pane-slot').boundingBox();
    const handle = await page.getByRole('button', { name: 'Resize all three views', exact: true }).boundingBox();
    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
    await page.mouse.down(); await page.mouse.move(handle.x + handle.width / 2 - 140, handle.y + handle.height / 2 + 100, { steps: 8 }); await page.mouse.up();
    const after = await page.locator('#main-pane-slot').boundingBox();
    const upperAfter = await page.locator('#upper-pane-slot').boundingBox();
    assert.ok(after.width < before.width - 100);
    assert.ok(upperAfter.height > upperBefore.height + 70);
    assert.equal(await page.locator('#main-pane-slot > div').getAttribute('id'), 'three-view-wrapper', 'dragging does not swap');
    assert.equal(await page.evaluate(() => typeof window.WallMode), 'undefined', 'layout is independent of exteriors');
    assert.equal(await page.locator('#tabResources').count(), 0);
  } finally { await browser.close(); }
});
